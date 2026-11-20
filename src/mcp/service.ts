import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { isNonRecoverableFailure } from "../durable-errors.js";
import { SqliteDurableExecutionStore } from "../durable-store.js";
import { copyJSON, hasText, isRecord } from "../durable-validation.js";
import type { DurableArtifactRef, DurableCheckpoint, DurableJSON, DurableRerun, DurableRunResult } from "../types/durable.js";
import type { McpWorkflowProgressView, McpWorkflowStatus } from "../types/mcp.js";
import { jsonFingerprint, McpWorkflowError, profileFingerprint, type McpConfig } from "./config.js";
import { SqliteMcpJobStore, type McpJob, type McpJobError } from "./job-store.js";
import { readResults } from "./results.js";
import { assertPipelineValue } from "../pipeline-schema.js";
import { jobError, requirePinnedProfile } from "./worker.js";

type Arguments = Record<string, unknown>;

function knownArguments(input: Arguments, names: readonly string[]): void {
  if (Object.keys(input).some(key => !names.includes(key))) {
    throw new McpWorkflowError("INVALID_ARGUMENT", "Unexpected tool argument.");
  }
}

function stringArg(input: Arguments, name: string, limit: number): string {
  const value = input[name];
  if (!hasText(value) || value.length > limit) {
    throw new McpWorkflowError("INVALID_ARGUMENT", name + " must be a nonempty string of at most " + limit + " characters.");
  }
  return value;
}

function optionalString(input: Arguments, name: string, limit: number): string | undefined {
  return input[name] === undefined ? undefined : stringArg(input, name, limit);
}

function optionalInteger(input: Arguments, name: string): number | undefined {
  const value = input[name];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new McpWorkflowError("INVALID_ARGUMENT", name + " must be a nonnegative safe integer.");
  }
  return value;
}

function optionalJsonObject(input: Arguments, name: string): Readonly<Record<string, DurableJSON>> {
  const value = input[name];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new McpWorkflowError("INVALID_ARGUMENT", name + " must be a JSON object.");
  return copyJSON(value, null, name, "INVALID_INPUT") as Readonly<Record<string, DurableJSON>>;
}

function rerunFingerprint({ expectedCheckpointSeq, stepKey, scope, params }: Omit<DurableRerun, "id">): string {
  return jsonFingerprint([expectedCheckpointSeq, stepKey, scope, params]);
}

function pendingRerun(job: McpJob, run: DurableRunResult | null): DurableRerun | null {
  return job.rerun && job.rerun.id !== run?.checkpoint.rerun?.id ? job.rerun : null;
}

function invocationCompleted(job: McpJob, run: DurableRunResult | null): boolean {
  return !pendingRerun(job, run) && (job.status === "completed" || run?.status === "completed");
}

function runActive(runId: string): McpWorkflowError {
  return new McpWorkflowError("RUN_ACTIVE", `The invocation or its durable lease is active. Call workflow_status with runId "${runId}".`);
}

function nextAction(
  status: McpWorkflowStatus["status"],
  runId: string,
  run: DurableRunResult | null,
  error: McpWorkflowStatus["error"],
): McpWorkflowStatus["nextAction"] {
  if (status === "completed") {
    return { action: "results", tool: "workflow_results", arguments: { runId }, reason: "Read the committed artifacts." };
  }
  if (status === "queued" || status === "running" || run?.status === "running") {
    const reason = status === "interrupted" || status === "cancelled" || status === "failed"
      ? "Wait for the durable execution lease to expire."
      : "Poll this invocation for its next checkpoint or progress report.";
    return { action: "status", tool: "workflow_status", arguments: { runId }, retryAfterMs: 1000, reason };
  }
  if (isNonRecoverableFailure(error) || (status === "failed" && error?.recoverable !== true)) {
    return { action: "inspect", tool: null, arguments: { runId }, reason: "Inspect the recorded failure before taking further action." };
  }
  return {
    action: "resume", tool: "workflow_resume",
    arguments: { runId, ...(run && { expectedCheckpointSeq: run.checkpoint.checkpointSeq }) },
    reason: "Resume the same run from its committed head.",
  };
}

function invocationState(job: McpJob, run: DurableRunResult | null) {
  const pending = pendingRerun(job, run);
  let status = job.status;
  // A worker with a live token still needs to publish the terminal job state before a new rerun can be queued.
  if (!pending && run?.status === "completed" && status !== "queued" && status !== "running") status = "completed";
  const workerLost = job.error?.code === "WORKER_EXITED" || job.error?.code === "WORKER_LEASE_EXPIRED";
  // A resume can lose its worker in the factory, before it has touched the previous invocation's failed head.
  const durableFailure = !pending && workerLost && job.activeAttemptId !== null && run?.status === "failed"
    ? run.error : null;
  if (durableFailure) status = "failed";
  const error = status === "completed" || status === "queued" || status === "running"
    ? null : durableFailure ?? job.error ?? (pending ? null : run?.error ?? null);
  return { status, error, pending };
}

function formatStatus(
  job: McpJob,
  run: DurableRunResult | null,
  committedHead: DurableCheckpoint | undefined,
): McpWorkflowStatus {
  const checkpoint = run?.checkpoint;
  const { status, error, pending } = invocationState(job, run);
  const lastCompletedStep = committedHead?.committed ? {
    stepKey: committedHead.committed.stepKey, generation: committedHead.generation,
    checkpointSeq: committedHead.checkpointSeq, outcome: committedHead.committed.outcome,
  } : null;
  const outcome = lastCompletedStep?.outcome ?? null;
  let state: McpWorkflowStatus["worker"]["state"] = "stopped";
  if (job.status === "queued") state = "starting";
  else if (job.status === "running") state = "alive";
  else if (job.expiresAt !== null) state = "expired";
  // Different databases can briefly expose the old progress row beside a newly committed head.
  const progress = job.progress && checkpoint && !pending &&
    (job.progress.checkpointSeq === checkpoint.checkpointSeq ||
      (!checkpoint.next && job.progress.stepKey === checkpoint.committed?.stepKey &&
        job.progress.checkpointSeq === checkpoint.previousCheckpointSeq))
    ? job.progress : null;
  return {
    runId: job.runId,
    profile: job.profile,
    status,
    checkpointSeq: checkpoint?.checkpointSeq ?? null,
    generation: checkpoint?.generation ?? null,
    currentStep: pending?.stepKey ?? checkpoint?.next?.stepKey ?? null,
    lastCompletedStep,
    lastProgressAt: job.lastProgressAt,
    progress,
    worker: {
      state, pid: job.workerPid, startedAt: job.startedAt, heartbeatAt: job.heartbeatAt,
      leaseExpiresAt: job.expiresAt === null ? null : new Date(job.expiresAt).toISOString(),
    },
    nextAction: nextAction(status, job.runId, run, error),
    domainStatus: outcome?.code ?? null,
    outcome,
    inputSha256: checkpoint?.input.sha256 ?? null,
    error,
    cancelRequested: job.cancelRequested,
    ...(checkpoint?.rerun && { rerun: checkpoint.rerun }),
    ...(pending && { pendingRerun: pending }),
  };
}

function progressPhase(status: McpWorkflowStatus, job: McpJob, durableAttemptId: string | null): McpWorkflowProgressView["stage"]["phase"] {
  if (status.status !== "running") return status.status;
  if (status.pendingRerun || status.checkpointSeq === null) return "preparing";
  if (status.currentStep === null) return "finalizing";
  return durableAttemptId !== null && job.activeAttemptId === durableAttemptId ? "executing" : "preparing";
}

function formatProgress(status: McpWorkflowStatus, job: McpJob, durableAttemptId: string | null): McpWorkflowProgressView {
  const stepKey = status.status === "completed" ? null : status.currentStep;
  const index = stepKey !== null ? job.stageOrder?.indexOf(stepKey) : undefined;
  const report = status.progress;
  const percent = report?.completed !== undefined && report.total !== undefined && report.total > 0
    ? Number(BigInt(report.completed) * 100n / BigInt(report.total)) : null;
  return {
    runId: status.runId, status: status.status, cancelRequested: status.cancelRequested,
    stage: {
      phase: progressPhase(status, job, durableAttemptId), stepKey,
      position: index !== undefined && index >= 0 ? index + 1 : null, total: job.stageOrder?.length ?? null,
    },
    lastCompletedStep: status.lastCompletedStep,
    detail: report && { ...report, percent },
    lastProgressAt: status.lastProgressAt,
    worker: status.worker,
    nextAction: {
      ...status.nextAction,
      tool: status.nextAction.tool === "workflow_status" ? "workflow_progress" : status.nextAction.tool,
    },
    error: status.error,
  };
}

export class McpWorkflowService {
  private readonly jobs: SqliteMcpJobStore;
  private readonly execution: SqliteDurableExecutionStore;

  constructor(private readonly config: McpConfig, private readonly workerEntry: string) {
    this.jobs = new SqliteMcpJobStore(config.jobDatabase);
    try {
      this.execution = new SqliteDurableExecutionStore(config.executionDatabase, { leaseMs: config.leaseMs });
    } catch (error) {
      this.jobs.close();
      throw error;
    }
  }

  close(): void {
    try {
      this.execution.close();
    } finally {
      this.jobs.close();
    }
  }

  /** The run binding and job reservation share the same SQLite transaction. */
  async callForSession(sessionId: string, name: string, args: Arguments, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    if (name === "workflow_start") {
      knownArguments(args, ["profile", "request", "idempotencyKey"]);
      return this.start(args, signal, sessionId);
    }
    const job = this.jobs.readBySession(sessionId);
    if (!job || job.runId !== args.runId) throw new McpWorkflowError("RUN_NOT_FOUND", "Run not found in this session.");
    if (name === "workflow_resume") {
      knownArguments(args, ["runId", "expectedCheckpointSeq", "expectedInputSha256"]);
      return this.resume(args, signal, true);
    }
    return this.call(name, args, signal);
  }

  async sessionView(sessionId: string, includeHistory = false) {
    const bound = this.jobs.readBySession(sessionId);
    if (!bound) return { run: null, progress: null, stageOrder: [], completedStages: [], publications: [] };
    const { status, job, committed, durableAttemptId } = await this.readStatus(bound.runId);
    const publications: { name: string; artifact: DurableArtifactRef }[] = [];
    if (status.status === "completed" && committed) {
      const refs = new Map(committed.artifacts.map(ref => [ref.id, ref]));
      const outputs = committed.outcome.outputs;
      if (Array.isArray(outputs)) {
        for (const output of outputs) {
          if (!isRecord(output) || !hasText(output.name) || !isRecord(output.artifact) || !hasText(output.artifact.id)) continue;
          const ref = refs.get(output.artifact.id);
          if (ref && ref.sha256 === output.artifact.sha256) publications.push({ name: output.name, artifact: ref });
        }
      } else if (committed.outcome.detailsRef) {
        const ref = refs.get(committed.outcome.detailsRef);
        if (ref) publications.push({ name: ref.kind, artifact: ref });
      } else {
        for (const ref of refs.values()) publications.push({ name: ref.kind, artifact: ref });
      }
    }
    const completedStages = includeHistory ? this.execution.committedStepKeys(bound.runId, status.checkpointSeq ?? 0) : [];
    return { run: status, progress: formatProgress(status, job, durableAttemptId), stageOrder: job.stageOrder ?? [], completedStages, publications };
  }

  async call(name: string, args: Arguments, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    switch (name) {
      case "workflow_list":
        knownArguments(args, []);
        return { profiles: Array.from(this.config.profiles.values(), ({name, revision, description}) =>
          ({name, revision, description: description ?? null})) };
      case "workflow_describe": {
        knownArguments(args, ["profile"]);
        const profile = this.config.profiles.get(stringArg(args, "profile", 128));
        if (!profile) throw new McpWorkflowError("PROFILE_NOT_FOUND", "Workflow profile is not registered.");
        return {
          name: profile.name, revision: profile.revision, description: profile.description ?? null,
          inputSchema: profile.inputSchema ?? { type: "object" }, outputSchema: profile.outputSchema ?? null,
          stageOrder: profile.stageOrder ?? null,
          ...(profile.operations && { operations: profile.operations }),
        };
      }
      case "workflow_start":
        knownArguments(args, ["profile", "request", "idempotencyKey"]);
        return this.start(args, signal);
      case "workflow_status":
        knownArguments(args, ["runId"]);
        return this.status(stringArg(args, "runId", 128));
      case "workflow_progress": {
        knownArguments(args, ["runId"]);
        const { status, job, durableAttemptId } = await this.readStatus(stringArg(args, "runId", 128));
        return formatProgress(status, job, durableAttemptId);
      }
      case "workflow_resume":
        knownArguments(args, ["runId", "expectedCheckpointSeq", "expectedInputSha256"]);
        return this.resume(args, signal);
      case "workflow_rerun":
        knownArguments(args, ["runId", "expectedCheckpointSeq", "stepKey", "scope", "params"]);
        return this.rerun(args, signal);
      case "workflow_cancel":
        knownArguments(args, ["runId"]);
        return this.cancel(stringArg(args, "runId", 128), signal);
      case "workflow_results": {
        knownArguments(args, ["runId", "artifactId", "cursor", "maxBytes"]);
        const job = this.requireJob(stringArg(args, "runId", 128));
        const artifactId = optionalString(args, "artifactId", 256);
        const cursor = optionalString(args, "cursor", 4096);
        const maxBytes = optionalInteger(args, "maxBytes");
        return readResults(this.execution, job.runId, await this.execution.readRun(job.runId), {
          ...(artifactId === undefined ? {} : { artifactId }),
          ...(cursor === undefined ? {} : { cursor }),
          ...(maxBytes === undefined ? {} : { maxBytes }),
        }, signal);
      }
      default:
        throw new McpWorkflowError("UNKNOWN_TOOL", "Unknown workflow tool.");
    }
  }

  private requireJob(runId: string): McpJob {
    const job = this.jobs.read(runId);
    if (!job) throw new McpWorkflowError("RUN_NOT_FOUND", "Workflow run was not found.");
    return job;
  }

  private async status(runId: string): Promise<McpWorkflowStatus> {
    return (await this.readStatus(runId)).status;
  }

  private async readStatus(runId: string) {
    // The worker commits durable state before publishing its terminal job status.
    const job = this.requireJob(runId);
    const head = this.execution.readRunWithActiveAttempt(runId);
    const run = head?.run ?? null;
    let checkpoint = run?.checkpoint;
    while (checkpoint && !checkpoint.committed && checkpoint.previousCheckpointSeq !== null) {
      checkpoint = await this.execution.readCheckpoint(runId, checkpoint.previousCheckpointSeq) ?? undefined;
    }
    return { job, status: formatStatus(job, run, checkpoint), committed: checkpoint?.committed, durableAttemptId: head?.activeAttemptId ?? null };
  }

  private async start(args: Arguments, signal: AbortSignal, sessionId?: string): Promise<McpWorkflowStatus> {
    const profileName = stringArg(args, "profile", 128);
    const key = stringArg(args, "idempotencyKey", 256);
    const idempotencyKey = sessionId ? "session/" + jsonFingerprint([sessionId, key]) : key;
    if (!isRecord(args.request)) throw new McpWorkflowError("INVALID_ARGUMENT", "request must be a JSON object.");
    const request = copyJSON(args.request, null, "Workflow request", "INVALID_INPUT");
    const requestFingerprint = jsonFingerprint(request);
    const existing = sessionId ? this.jobs.readBySession(sessionId) : this.jobs.readByKey(profileName, idempotencyKey);
    const recover = (job: McpJob) => {
      if ((job.sessionId ?? null) !== (sessionId ?? null) || job.profile !== profileName || job.idempotencyKey !== idempotencyKey) {
        throw new McpWorkflowError("IDEMPOTENCY_CONFLICT", "Another start request already reserved this execution.");
      }
      return this.deduplicatedStart(job, requestFingerprint);
    };
    if (existing) return recover(existing);
    const profile = this.config.profiles.get(profileName);
    if (!profile) throw new McpWorkflowError("PROFILE_NOT_FOUND", "Workflow profile is not registered.");
    if (profile.inputSchema) {
      try {
        assertPipelineValue(profile.inputSchema, request, "request");
      } catch (error) {
        throw new McpWorkflowError("INVALID_ARGUMENT", error instanceof Error ? error.message : "Invalid workflow request.");
      }
    }
    let pinned: string;
    try {
      pinned = profileFingerprint(profile);
    } catch {
      throw new McpWorkflowError("PROFILE_MODULE_UNAVAILABLE", "The registered workflow module cannot be read.");
    }
    signal.throwIfAborted();
    const { job, created } = this.jobs.start({
      runId: randomUUID(), sessionId: sessionId ?? null, profile: profileName, profileFingerprint: pinned,
      ...(profile.stageOrder && { stageOrder: profile.stageOrder }),
      request, requestFingerprint, idempotencyKey, token: randomUUID(),
      status: "queued", cancelRequested: false, error: null, rerun: null,
    }, this.config.queueMs);
    if (!created) return recover(job);
    this.launch(job);
    return this.status(job.runId);
  }

  private deduplicatedStart(job: McpJob, requestFingerprint: string): Promise<McpWorkflowStatus> {
    if (job.requestFingerprint !== requestFingerprint) {
      throw new McpWorkflowError("IDEMPOTENCY_CONFLICT", "The idempotency key is already used with a different request.");
    }
    return this.status(job.runId);
  }

  private async resume(args: Arguments, signal: AbortSignal, guardHead = false): Promise<McpWorkflowStatus> {
    const runId = stringArg(args, "runId", 128);
    const expectedSeq = optionalInteger(args, "expectedCheckpointSeq");
    const expectedSha = optionalString(args, "expectedInputSha256", 64);
    if (expectedSha !== undefined && !/^[0-9a-f]{64}$/u.test(expectedSha)) {
      throw new McpWorkflowError("INVALID_ARGUMENT", "expectedInputSha256 must be a lowercase SHA-256 digest.");
    }
    const job = this.requireJob(runId);
    const run = await this.execution.readRun(runId);
    if (guardHead && run && (expectedSeq === undefined || expectedSha === undefined)) {
      throw new McpWorkflowError("INVALID_ARGUMENT", "Read session_context and supply the checkpoint sequence and input SHA-256 to resume.");
    }
    if (expectedSeq !== undefined && expectedSeq !== run?.checkpoint.checkpointSeq) {
      throw new McpWorkflowError("CHECKPOINT_CONFLICT", "Expected checkpoint differs from the committed head.");
    }
    if (expectedSha !== undefined && expectedSha !== run?.checkpoint.input.sha256) {
      throw new McpWorkflowError("INPUT_SNAPSHOT_MISMATCH", "Expected input hash differs from the committed snapshot.");
    }
    if (invocationCompleted(job, run)) return this.status(runId);
    if (job.status === "running" || job.status === "queued" || run?.status === "running") {
      throw runActive(runId);
    }
    const failure = invocationState(job, run).error;
    if (failure?.recoverable === false || failure?.cause?.recoverable === false) throw failure;
    requirePinnedProfile(this.config, job);
    signal.throwIfAborted();
    const scheduled = this.jobs.queueResume(runId, job.token, randomUUID(), this.config.queueMs);
    if (!scheduled) throw new McpWorkflowError("CHECKPOINT_CONFLICT", "Another executor changed the invocation.");
    this.launch(scheduled);
    return this.status(runId);
  }

  private async rerun(args: Arguments, signal: AbortSignal): Promise<McpWorkflowStatus> {
    const runId = stringArg(args, "runId", 128);
    const expectedCheckpointSeq = optionalInteger(args, "expectedCheckpointSeq");
    if (expectedCheckpointSeq === undefined) {
      throw new McpWorkflowError("INVALID_ARGUMENT", "expectedCheckpointSeq is required.");
    }
    const fields = {
      expectedCheckpointSeq,
      stepKey: stringArg(args, "stepKey", 256),
      scope: optionalJsonObject(args, "scope"),
      params: optionalJsonObject(args, "params"),
    };
    const fingerprint = rerunFingerprint(fields);
    const isDuplicate = (job: McpJob) => job.rerun !== null && rerunFingerprint(job.rerun) === fingerprint;
    const job = this.requireJob(runId);
    const run = await this.execution.readRun(runId);
    // Planning may fail before it commits pending work. Allow that same request
    // after its external prerequisite becomes available, while preserving
    // idempotency for active or already committed reruns.
    const failedBeforeCommit = job.status === "failed" && job.rerun?.id !== run?.checkpoint.rerun?.id;
    if (isDuplicate(job) && !failedBeforeCommit) return this.status(runId);
    if (expectedCheckpointSeq !== run?.checkpoint.checkpointSeq) {
      throw new McpWorkflowError("CHECKPOINT_CONFLICT", "Expected checkpoint differs from the committed head.");
    }
    if (job.status === "running" || job.status === "queued" || run.status === "running") {
      throw runActive(runId);
    }
    requirePinnedProfile(this.config, job);
    signal.throwIfAborted();

    const rerun = { id: randomUUID(), ...fields };
    const scheduled = this.jobs.queueRerun(runId, job.token, randomUUID(), this.config.queueMs, rerun);
    if (!scheduled) {
      if (isDuplicate(this.requireJob(runId))) return this.status(runId);
      throw new McpWorkflowError("CHECKPOINT_CONFLICT", "Another executor changed the invocation.");
    }
    this.launch(scheduled);
    return this.status(runId);
  }

  private async cancel(runId: string, signal: AbortSignal): Promise<McpWorkflowStatus> {
    const job = this.requireJob(runId);
    const run = await this.execution.readRun(runId);
    signal.throwIfAborted();
    if (invocationCompleted(job, run)) return this.status(runId);
    this.jobs.cancel(runId);
    return this.status(runId);
  }

  private launch(job: McpJob): void {
    let log: number | undefined;
    try {
      const directory = join(this.config.stateDirectory, "runs", job.runId);
      mkdirSync(directory, { recursive: true });
      log = openSync(join(directory, "worker.log"), "a", 0o600);
      const sqliteFlag = process.execArgv.includes("--experimental-sqlite") ? ["--experimental-sqlite"] : [];
      const workerEnv = { ...process.env };
      delete workerEnv.ATK_SERVICE_TOKEN;
      const child = spawn(process.execPath, [
        ...sqliteFlag, this.workerEntry, "--config", this.config.configPath, "--worker", job.runId, job.token,
      ], { detached: true, windowsHide: true, stdio: ["ignore", log, log], env: workerEnv });
      child.once("error", error => this.recordWorkerFailure(job, jobError(error, "WORKER_LAUNCH_FAILED"), "launch"));
      child.once("exit", (code, signal) => {
        this.recordWorkerFailure(job, {
          code: "WORKER_EXITED", message: `Worker exited before recording completion (${signal ?? code}).`, recoverable: true,
        }, "exit");
      });
      child.unref();
    } catch (error) {
      this.recordWorkerFailure(job, jobError(error, "WORKER_LAUNCH_FAILED"), "launch");
    } finally {
      if (log !== undefined) closeSync(log);
    }
  }

  private recordWorkerFailure(job: McpJob, error: McpJobError, event: "launch" | "exit"): void {
    try {
      const jobs = new SqliteMcpJobStore(this.config.jobDatabase);
      try {
        if (event === "exit") {
          jobs.noteExit(job.runId, job.token, error);
        } else if (jobs.read(job.runId)?.status === "queued") {
          jobs.finish(job.runId, job.token, "failed", error);
        }
      } finally {
        jobs.close();
      }
    } catch (failure) {
      process.stderr.write("Could not persist worker " + event + " event: " + String(failure) + "\n");
    }
  }
}
