import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { SqliteDurableExecutionStore } from "../durable-store.js";
import { copyJSON, hasText, isRecord } from "../durable-validation.js";
import type { DurableJSON, DurableRerun, DurableRunResult } from "../types/durable.js";
import type { McpWorkflowStatus } from "../types/mcp.js";
import { jsonFingerprint, McpWorkflowError, profileFingerprint, type McpConfig } from "./config.js";
import { SqliteMcpJobStore, type McpJob } from "./job-store.js";
import { readResults } from "./results.js";
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

function formatStatus(
  job: McpJob,
  run: DurableRunResult | null,
  outcome = run?.checkpoint.committed?.outcome ?? null,
): McpWorkflowStatus {
  const checkpoint = run?.checkpoint;
  const pending = pendingRerun(job, run);
  let status = job.status;
  if (!pending && run?.status === "completed") status = "completed";
  if (status === "interrupted" && run?.status === "running") status = "running";
  return {
    runId: job.runId,
    profile: job.profile,
    status,
    checkpointSeq: checkpoint?.checkpointSeq ?? null,
    generation: checkpoint?.generation ?? null,
    currentStep: pending?.stepKey ?? checkpoint?.next?.stepKey ?? null,
    domainStatus: outcome?.code ?? null,
    outcome,
    inputSha256: checkpoint?.input.sha256 ?? null,
    error: status === "completed" || status === "queued" || status === "running"
      ? null
      : job.error ?? (pending ? null : run?.error ?? null),
    cancelRequested: job.cancelRequested,
    ...(checkpoint?.rerun && { rerun: checkpoint.rerun }),
    ...(pending && { pendingRerun: pending }),
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

  async call(name: string, args: Arguments, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    switch (name) {
      case "workflow_start":
        knownArguments(args, ["profile", "request", "idempotencyKey"]);
        return this.start(args, signal);
      case "workflow_status":
        knownArguments(args, ["runId"]);
        return this.status(stringArg(args, "runId", 128));
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
    // The worker commits durable state before publishing its terminal job status.
    const job = this.requireJob(runId);
    const run = await this.execution.readRun(runId);
    let checkpoint = run?.checkpoint;
    while (checkpoint && !checkpoint.committed && checkpoint.previousCheckpointSeq !== null) {
      checkpoint = await this.execution.readCheckpoint(runId, checkpoint.previousCheckpointSeq) ?? undefined;
    }
    return formatStatus(job, run, checkpoint?.committed?.outcome ?? null);
  }

  private async start(args: Arguments, signal: AbortSignal): Promise<McpWorkflowStatus> {
    const profileName = stringArg(args, "profile", 128);
    const idempotencyKey = stringArg(args, "idempotencyKey", 256);
    if (!isRecord(args.request)) throw new McpWorkflowError("INVALID_ARGUMENT", "request must be a JSON object.");
    const request = copyJSON(args.request, null, "Workflow request", "INVALID_INPUT");
    const requestFingerprint = jsonFingerprint(request);
    const existing = this.jobs.readByKey(profileName, idempotencyKey);
    if (existing) return this.deduplicatedStart(existing, requestFingerprint);
    const profile = this.config.profiles.get(profileName);
    if (!profile) throw new McpWorkflowError("PROFILE_NOT_FOUND", "Workflow profile is not registered.");
    let pinned: string;
    try {
      pinned = profileFingerprint(profile);
    } catch {
      throw new McpWorkflowError("PROFILE_MODULE_UNAVAILABLE", "The registered workflow module cannot be read.");
    }
    signal.throwIfAborted();
    const { job, created } = this.jobs.start({
      runId: randomUUID(), profile: profileName, profileFingerprint: pinned,
      request, requestFingerprint, idempotencyKey, token: randomUUID(),
      status: "queued", cancelRequested: false, error: null, rerun: null,
    }, this.config.queueMs);
    if (!created) return this.deduplicatedStart(job, requestFingerprint);
    this.launch(job);
    return this.status(job.runId);
  }

  private deduplicatedStart(job: McpJob, requestFingerprint: string): Promise<McpWorkflowStatus> {
    if (job.requestFingerprint !== requestFingerprint) {
      throw new McpWorkflowError("IDEMPOTENCY_CONFLICT", "The idempotency key is already used with a different request.");
    }
    return this.status(job.runId);
  }

  private async resume(args: Arguments, signal: AbortSignal): Promise<McpWorkflowStatus> {
    const runId = stringArg(args, "runId", 128);
    const expectedSeq = optionalInteger(args, "expectedCheckpointSeq");
    const expectedSha = optionalString(args, "expectedInputSha256", 64);
    if (expectedSha !== undefined && !/^[0-9a-f]{64}$/u.test(expectedSha)) {
      throw new McpWorkflowError("INVALID_ARGUMENT", "expectedInputSha256 must be a lowercase SHA-256 digest.");
    }
    const job = this.requireJob(runId);
    const run = await this.execution.readRun(runId);
    if (expectedSeq !== undefined && expectedSeq !== run?.checkpoint.checkpointSeq) {
      throw new McpWorkflowError("CHECKPOINT_CONFLICT", "Expected checkpoint differs from the committed head.");
    }
    if (expectedSha !== undefined && expectedSha !== run?.checkpoint.input.sha256) {
      throw new McpWorkflowError("INPUT_SNAPSHOT_MISMATCH", "Expected input hash differs from the committed snapshot.");
    }
    if (invocationCompleted(job, run)) return formatStatus(job, run);
    if (job.status === "running" || job.status === "queued" || run?.status === "running") {
      throw new McpWorkflowError("RUN_ACTIVE", "The run has a queued or active invocation.");
    }
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
      stepKey: stringArg(args, "stepKey", 128),
      scope: optionalJsonObject(args, "scope"),
      params: optionalJsonObject(args, "params"),
    };
    const fingerprint = rerunFingerprint(fields);
    const isDuplicate = (job: McpJob) => job.rerun !== null && rerunFingerprint(job.rerun) === fingerprint;
    const job = this.requireJob(runId);
    if (isDuplicate(job)) return this.status(runId);

    const run = await this.execution.readRun(runId);
    if (expectedCheckpointSeq !== run?.checkpoint.checkpointSeq) {
      throw new McpWorkflowError("CHECKPOINT_CONFLICT", "Expected checkpoint differs from the committed head.");
    }
    if (job.status === "running" || job.status === "queued" || run.status === "running") {
      throw new McpWorkflowError("RUN_ACTIVE", "The run has a queued or active invocation.");
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
    if (invocationCompleted(job, run)) return formatStatus(job, run);
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
      const child = spawn(process.execPath, [
        ...sqliteFlag, this.workerEntry, "--config", this.config.configPath, "--worker", job.runId, job.token,
      ], { detached: true, windowsHide: true, stdio: ["ignore", log, log] });
      child.once("error", error => this.noteLaunchFailure(job, error));
      child.once("exit", (code, signal) => {
        if (code !== 0) this.noteLaunchFailure(job, new Error("Worker exited before claiming its invocation (" + (signal ?? code) + ")."));
      });
      child.unref();
    } catch (error) {
      this.noteLaunchFailure(job, error);
    } finally {
      if (log !== undefined) closeSync(log);
    }
  }

  private noteLaunchFailure(job: McpJob, error: unknown): void {
    try {
      const jobs = new SqliteMcpJobStore(this.config.jobDatabase);
      try {
        const current = jobs.read(job.runId);
        if (current?.status === "queued" && current.token === job.token) {
          jobs.finish(job.runId, job.token, "failed", jobError(error, "WORKER_LAUNCH_FAILED"));
        }
      } finally {
        jobs.close();
      }
    } catch (failure) {
      process.stderr.write("Could not persist worker launch failure: " + String(failure) + "\n");
    }
  }
}
