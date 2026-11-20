import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { advanceInput, resumeDurable, runDurable, scheduleDurableRerun, verifyDurableCheckpointArtifacts } from "../durable-execution.js";
import { normalizeFailure } from "../durable-errors.js";
import { SqliteDurableExecutionStore } from "../durable-store.js";
import { sameSnapshot, validateSnapshot } from "../durable-validation.js";
import type { DurableAttempt, DurableCheckpoint, DurableExecutionStore, DurableJSON, DurableRunResult } from "../types/durable.js";
import type { McpWorkflowFactory, McpWorkflowPlan, McpWorkflowProfile, McpWorkflowProgressUpdate } from "../types/mcp.js";
import { McpWorkflowError, profileFingerprint, type McpConfig } from "./config.js";
import { SqliteMcpJobStore, type McpJobError, type McpJob } from "./job-store.js";

export function jobError(error: unknown, fallbackCode: string): McpJobError {
  return normalizeFailure(error, fallbackCode);
}

export function requirePinnedProfile(config: McpConfig, job: McpJob): McpWorkflowProfile {
  const profile = config.profiles.get(job.profile);
  if (profile) {
    try {
      if (profileFingerprint(profile) === job.profileFingerprint) {
        const { stageOrder: _configuredOrder, ...pinned } = profile;
        return job.stageOrder === null ? pinned : { ...pinned, stageOrder: job.stageOrder };
      }
    } catch {
      // A removed or unreadable registered module also breaks the profile pin.
    }
  }
  throw new McpWorkflowError("WORKFLOW_REVISION_MISMATCH", "The registered workflow profile differs from the run's pinned profile.");
}

function requireMatchingInput(plan: McpWorkflowPlan, checkpoint: DurableCheckpoint): void {
  const expected = validateSnapshot(plan.input, checkpoint);
  if (!sameSnapshot(checkpoint.input, expected)) {
    throw new McpWorkflowError("INPUT_SNAPSHOT_MISMATCH", "The plugin input differs from the current committed snapshot.");
  }
}

class OwnedWorkflowStore extends SqliteDurableExecutionStore {
  private attempt: DurableAttempt | null = null;

  constructor(
    config: McpConfig,
    private readonly assertOwned: () => void,
    private readonly jobs: SqliteMcpJobStore,
    private readonly runId: string,
    private readonly token: string,
  ) {
    super(config.executionDatabase, { leaseMs: config.leaseMs });
  }

  reportProgress(update: McpWorkflowProgressUpdate): void {
    if (this.attempt) this.jobs.reportProgress(this.runId, this.token, this.attempt, update);
  }

  override close(): void {
    this.attempt = null;
    super.close();
  }

  override async createRun(...args: Parameters<DurableExecutionStore["createRun"]>) {
    this.assertOwned();
    return super.createRun(...args);
  }

  override async acquire(...args: Parameters<DurableExecutionStore["acquire"]>) {
    this.assertOwned();
    return super.acquire(...args);
  }

  override async renew(...args: Parameters<DurableExecutionStore["renew"]>) {
    this.assertOwned();
    return super.renew(...args);
  }

  override async beginAttempt(...args: Parameters<DurableExecutionStore["beginAttempt"]>) {
    this.assertOwned();
    const attempt = await super.beginAttempt(...args);
    if (attempt && args[0] === this.runId) {
      this.attempt = attempt;
      this.jobs.markStep(this.runId, this.token, attempt.attemptId);
    }
    return attempt;
  }

  override async commit(...args: Parameters<DurableExecutionStore["commit"]>) {
    this.assertOwned();
    const committed = await super.commit(...args);
    const [checkpoint] = args;
    if (committed && checkpoint.runId === this.runId) {
      this.attempt = null;
      this.jobs.markStep(this.runId, this.token, null, checkpoint.next === null);
    }
    return committed;
  }

  override async stop(...args: Parameters<DurableExecutionStore["stop"]>) {
    this.assertOwned();
    const stopped = await super.stop(...args);
    if (stopped && args[0] === this.runId) this.attempt = null;
    return stopped;
  }
}

async function executePlan(
  runId: string,
  store: SqliteDurableExecutionStore,
  plan: McpWorkflowPlan,
  checkpoint: DurableCheckpoint | null,
  stepLimit: number | undefined,
  signal: AbortSignal,
  assertActive: () => void,
): Promise<DurableRunResult> {
  const { workflow, prepareNext, pauseBefore } = plan;
  let remaining = stepLimit ?? Infinity;
  let latest: DurableRunResult | undefined;
  let head = checkpoint;
  if (head) requireMatchingInput(plan, head);
  let expectedInput = plan.input;

  while (true) {
    assertActive();
    if (head?.next && pauseBefore && await pauseBefore({ checkpoint: structuredClone(head), signal })) {
      assertActive();
      return { runId, status: "interrupted", checkpoint: head, error: null };
    }
    if (head?.next && prepareNext) {
      const change = await prepareNext({ checkpoint: structuredClone(head), signal });
      assertActive();
      if (change) {
        head = await advanceInput(runId, { ...change, workflow, expectedCheckpointSeq: head.checkpointSeq, store });
        expectedInput = head.input;
      }
    }

    const maxSteps = prepareNext || pauseBefore ? 1 : stepLimit;
    const options = { store, signal, ...(maxSteps === undefined ? {} : { maxSteps }) };
    const previousSeq = head?.checkpointSeq ?? 0;
    assertActive();
    if (head) {
      latest = await resumeDurable(runId, {
        ...options,
        workflow,
        expectedInput,
        expectedCheckpointSeq: head.checkpointSeq,
      });
    } else {
      latest = await runDurable(workflow, { ...options, input: expectedInput, first: plan.first, runId });
    }
    const committed = latest.checkpoint.checkpointSeq - previousSeq;
    remaining -= committed;
    if (latest.status !== "interrupted" || remaining <= 0 || (!prepareNext && !pauseBefore)) return latest;
    head = latest.checkpoint;
    expectedInput = head.input;
  }
}

export async function runMcpWorker(config: McpConfig, runId: string, token: string): Promise<void> {
  const jobs = new SqliteMcpJobStore(config.jobDatabase);
  try {
    const job = jobs.claim(runId, token, config.leaseMs);
    if (!job) return;
    const controller = new AbortController();
    const signal = controller.signal;
    const cancelled = new McpWorkflowError("CANCELLED", "Workflow cancellation was requested.");
    let ownershipLoss: Error | undefined;
    const pulse = () => {
      if (ownershipLoss) return;
      try {
        const current = jobs.renew(runId, token, config.leaseMs);
        if (!current) throw new McpWorkflowError("WORKER_LEASE_LOST", "The worker no longer owns this invocation.");
        if (current.cancelRequested) controller.abort(cancelled);
      } catch (error) {
        ownershipLoss = error instanceof Error ? error : new Error(String(error));
        controller.abort(ownershipLoss);
      }
    };
    const assertOwned = () => {
      pulse();
      if (ownershipLoss) throw ownershipLoss;
    };
    const assertActive = () => {
      assertOwned();
      signal.throwIfAborted();
    };
    const heartbeat = setInterval(pulse, Math.min(250, Math.floor(config.leaseMs / 3)));
    heartbeat.unref();

    let store: OwnedWorkflowStore | undefined;
    try {
      assertActive();
      store = new OwnedWorkflowStore(config, assertOwned, jobs, runId, token);
      const current = await store.readRun(runId);
      let checkpoint = current?.checkpoint ?? null;
      const pending = job.rerun && job.rerun.id !== checkpoint?.rerun?.id ? job.rerun : null;
      if (current?.status === "completed" && !pending) {
        jobs.finish(runId, token, "completed", null);
        return;
      }
      if (current) await verifyDurableCheckpointArtifacts(store, current.checkpoint);
      assertActive();
      const profile = requirePinnedProfile(config, job);
      const module: { createWorkflow?: McpWorkflowFactory } = await import(pathToFileURL(profile.module).href);
      assertActive();
      if (typeof module.createWorkflow !== "function") {
        throw new McpWorkflowError("INVALID_WORKFLOW_PLUGIN", "Registered module must export createWorkflow.");
      }
      requirePinnedProfile(config, job);
      const workDirectory = join(config.stateDirectory, "runs", runId);
      mkdirSync(workDirectory, { recursive: true });
      const plan = await module.createWorkflow({
        runId, workDirectory, profile, request: job.request as Readonly<Record<string, DurableJSON>>,
        store, checkpoint, signal,
        reportProgress(update) {
          if (!signal.aborted) store?.reportProgress(update);
        },
      });
      assertActive();
      if (plan?.workflow?.revision !== profile.revision) {
        throw new McpWorkflowError("WORKFLOW_REVISION_MISMATCH", "The plugin workflow revision must match its registered profile.");
      }
      if (pending) {
        if (!checkpoint || checkpoint.checkpointSeq !== pending.expectedCheckpointSeq) {
          throw new McpWorkflowError("CHECKPOINT_CONFLICT", "The rerun's selected checkpoint is no longer the committed head.");
        }
        if (typeof plan.planRerun !== "function") {
          throw new McpWorkflowError("RERUN_UNSUPPORTED", "This workflow profile does not support stage reruns.");
        }
        requireMatchingInput(plan, checkpoint);
        const next = await plan.planRerun({ checkpoint: structuredClone(checkpoint), request: structuredClone(pending), signal });
        assertActive();
        checkpoint = await scheduleDurableRerun(runId, { workflow: plan.workflow, rerun: pending, next, store, signal });
      }
      const result = await executePlan(runId, store, plan, checkpoint, profile.maxSteps, signal, assertActive);
      jobs.finish(runId, token, result.status === "running" ? "interrupted" : result.status, result.error);
    } catch (error) {
      if (signal.reason === cancelled) jobs.finish(runId, token, "cancelled", jobError(cancelled, "CANCELLED"));
      else jobs.finish(runId, token, "failed", jobError(error, "WORKER_FAILED"));
    } finally {
      clearInterval(heartbeat);
      store?.close();
    }
  } finally {
    jobs.close();
  }
}
