import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { scheduleDurableRerun, verifyDurableCheckpointArtifacts } from "./durable-execution.js";
import { SqliteDurableExecutionStore } from "./durable-store.js";
import { DurableExecutionError, hasText, isRecord, readVerifiedArtifact, sha256 } from "./durable-validation.js";
import { executePlan, requireMatchingInput } from "./mcp/execute-plan.js";
import type { DurableJSON } from "./types/durable.js";
import type { McpWorkflowProfile } from "./types/mcp.js";
import type { PipelineDefinition, PipelineFactory, PipelineRunOptions, PipelineRunResult } from "./types/pipeline.js";

/** Run or resume the same pinned pipeline locally that an MCP worker would execute. */
export async function runPipeline(
  pipeline: PipelineDefinition | PipelineFactory,
  request: DurableJSON,
  options: PipelineRunOptions = {},
): Promise<PipelineRunResult> {
  const { signal = new AbortController().signal, rerun, expectedCheckpointSeq } = options;
  const maxSteps = options.maxSteps ?? options.profile?.maxSteps;
  if (maxSteps !== undefined && (!Number.isSafeInteger(maxSteps) || maxSteps < 1)) {
    throw new DurableExecutionError("INVALID_INPUT", "maxSteps must be a positive safe integer.");
  }
  if (expectedCheckpointSeq !== undefined && (!Number.isSafeInteger(expectedCheckpointSeq) || expectedCheckpointSeq < 0)) {
    throw new DurableExecutionError("INVALID_INPUT", "expectedCheckpointSeq must be a nonnegative safe integer.");
  }
  const resuming = options.resume || !!rerun;
  if (resuming && !hasText(options.runId)) throw new TypeError("Resume and rerun require a runId.");
  if (expectedCheckpointSeq !== undefined && !resuming) throw new TypeError("expectedCheckpointSeq requires an existing run.");
  const runId = options.runId ?? randomUUID();
  if (!hasText(runId)) throw new TypeError("runId must be a nonblank string.");
  const stateDirectory = resolve(options.stateDirectory ?? join("out", "pipelines"));
  // Match the MCP host's UUID directories. Arbitrary caller IDs never become path components.
  const directoryName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(runId)
    ? runId : "id-" + sha256(Buffer.from(runId));
  const workDirectory = join(stateDirectory, "runs", directoryName);
  const local = options.store ? undefined : new SqliteDurableExecutionStore(join(stateDirectory, "execution.sqlite"));
  const store = options.store ?? local!;
  try {
    signal.throwIfAborted();
    const current = await store.readRun(runId);
    let checkpoint = current?.checkpoint ?? null;
    if (resuming && !checkpoint) throw new DurableExecutionError("RUN_NOT_FOUND", "Durable run was not found.", { runId, checkpointSeq: null });
    if (!resuming && checkpoint) throw new DurableExecutionError("CHECKPOINT_CONFLICT", "Run already exists.", checkpoint);
    const alreadyScheduled = !!rerun && checkpoint?.rerun?.id === rerun.id;
    if (checkpoint && ((expectedCheckpointSeq !== undefined && expectedCheckpointSeq !== checkpoint.checkpointSeq) ||
        (rerun && !alreadyScheduled && rerun.expectedCheckpointSeq !== checkpoint.checkpointSeq))) {
      throw new DurableExecutionError("CHECKPOINT_CONFLICT", "Expected checkpoint differs from the committed head.", checkpoint);
    }
    if (checkpoint) await verifyDurableCheckpointArtifacts(store, checkpoint);
    await mkdir(workDirectory, { recursive: true });
    const profile: McpWorkflowProfile = options.profile ?? {
      name: typeof pipeline === "function" ? "local" : pipeline.key, module: "local", settings: {},
      revision: pipeline.descriptor?.revision ?? "local",
    };
    const host = { runId, profile, store, checkpoint, workDirectory, signal, reportProgress: options.reportProgress ?? (() => {}) };
    let plan;
    if (typeof pipeline === "function") {
      if (!isRecord(request)) throw new TypeError("An MCP workflow factory requires an object request.");
      plan = await pipeline({ ...host, request: request as Readonly<Record<string, DurableJSON>> });
    } else {
      plan = await pipeline.createWorkflow({ ...host, request });
    }
    if (options.profile && plan.workflow.revision !== profile.revision) {
      throw new DurableExecutionError("WORKFLOW_REVISION_MISMATCH", "Workflow revision differs from the supplied profile.", checkpoint);
    }
    if (checkpoint && rerun) {
      requireMatchingInput(plan, checkpoint);
      if (alreadyScheduled) {
        // Retries may arrive after a rerun already committed its suffix.
        if (!isDeepStrictEqual(checkpoint.rerun, rerun)) {
          throw new DurableExecutionError("CHECKPOINT_CONFLICT", "The rerun ID is already bound to a different request.", checkpoint);
        }
      } else {
        if (!plan.planRerun) throw new TypeError("Workflow does not support stage reruns.");
        const next = await plan.planRerun({ checkpoint: structuredClone(checkpoint), request: structuredClone(rerun), signal });
        checkpoint = await scheduleDurableRerun(runId, { workflow: plan.workflow, store, next, rerun, signal });
      }
    }
    const result = await executePlan(runId, store, plan, checkpoint, maxSteps, signal, () => signal.throwIfAborted());
    // Domain artifacts can contain arbitrary bytes, even when a kind shares the value pipeline prefix.
    if (pipeline.descriptor && "mode" in pipeline.descriptor && pipeline.descriptor.mode === "durable") return result;
    const committed = result.checkpoint.committed;
    const ref = committed?.artifacts.find(artifact => artifact.id === committed.outcome.detailsRef && artifact.kind.startsWith("pipeline-output/"));
    if (result.status !== "completed" || !ref) return result;
    const bytes = await readVerifiedArtifact(store, ref, result.checkpoint);
    return { ...result, output: JSON.parse(Buffer.from(bytes).toString("utf8")) as DurableJSON };
  } finally {
    local?.close();
  }
}
