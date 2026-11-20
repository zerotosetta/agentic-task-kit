import { canonicalJSON, copyJSON, DurableExecutionError, hasText, isRecord, manifestRef, readVerifiedArtifact, sha256 } from "./durable-validation.js";
import { defineDurablePipeline } from "./pipeline-domain.js";
import { assertPipelineSchema, assertPipelineValue } from "./pipeline-schema.js";
import type { DurableArtifactRef, DurableCheckpoint, DurableExecutionStore, DurableJSON, DurableRerun, DurableStep, DurableWork } from "./types/durable.js";
import type { DurablePipelineDefinition, DurablePipelineOptions, PipelineDefinition, PipelineHostContext, PipelineOptions, PipelineStep, PipelineStepContext } from "./types/pipeline.js";

export { runPipeline } from "./pipeline-runner.js";
export type * from "./types/pipeline.js";

type PathEntry = { artifactId: string; sha256: string; checkpointSeq: number };
type Path = {
  previous: string | null;
  outputs: Record<string, PathEntry>;
  transitions: number;
};

function encode(value: DurableJSON): Buffer {
  return Buffer.from(canonicalJSON(value));
}

function schemaCopy(schema: unknown, label: string) {
  assertPipelineSchema(schema, label);
  return structuredClone(schema);
}

function prepareSteps(definition: PipelineOptions): Map<string, PipelineStep> {
  if (!Array.isArray(definition.steps) || !definition.steps.length || definition.steps.length > 256) {
    throw new TypeError("A pipeline requires 1 to 256 steps.");
  }
  const steps = new Map<string, PipelineStep>();
  for (const [index, step] of definition.steps.entries()) {
    if (!hasText(step?.key) || step.key.length > 256 || steps.has(step.key) || typeof step.run !== "function") {
      throw new TypeError("Every pipeline step requires a unique key of up to 256 characters and a run handler.");
    }
    if ((step.selectInput !== undefined && typeof step.selectInput !== "function") ||
        (step.waitUntil !== undefined && typeof step.waitUntil !== "function") ||
        (step.pauseAfter !== undefined && typeof step.pauseAfter !== "boolean") ||
        (step.description !== undefined && typeof step.description !== "string")) {
      throw new TypeError("Invalid options on step " + step.key + ".");
    }
    steps.set(step.key, {
      ...step,
      inputSchema: schemaCopy(step.inputSchema, step.key + " input schema"),
      outputSchema: schemaCopy(step.outputSchema, step.key + " output schema"),
      next: step.next === undefined ? definition.steps[index + 1]?.key ?? null : step.next,
    });
  }
  for (const step of steps.values()) {
    if (step.next !== null && typeof step.next !== "function" && !steps.has(step.next!)) {
      throw new TypeError("Unknown next step for " + step.key + ".");
    }
  }
  return steps;
}

/** Read the declaration's pinned rules before reconstructing a per-run pipeline in a new worker. */
export async function readPinnedPipelineRules(store: DurableExecutionStore, checkpoint: DurableCheckpoint): Promise<DurableJSON> {
  const bytes = await readVerifiedArtifact(store, manifestRef(checkpoint.input), checkpoint);
  const manifest: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!isRecord(manifest) || manifest.format !== "atk-pipeline/1" ||
      !isRecord(manifest.definition) || !Object.hasOwn(manifest.definition, "rules")) {
    throw new DurableExecutionError("INVALID_INPUT", "Expected a pinned pipeline manifest.", checkpoint);
  }
  return copyJSON(manifest.definition.rules, checkpoint, "Pipeline rules", "INVALID_INPUT");
}

async function getOutputs(path: Path, read: (ref: DurableArtifactRef) => Promise<Uint8Array>) {
  const outputs = Object.create(null) as Record<string, DurableJSON>;
  for (const [key, entry] of Object.entries(path.outputs)) {
    const ref = { id: entry.artifactId, kind: "pipeline-output/" + key, sha256: entry.sha256 };
    outputs[key] = JSON.parse(Buffer.from(await read(ref)).toString("utf8")) as DurableJSON;
  }
  return outputs;
}

/** Compile an ordered, schema-checked pipeline to the durable runtime and MCP plugin contract. */
export function definePipeline(options: PipelineOptions): PipelineDefinition;
export function definePipeline(options: DurablePipelineOptions): DurablePipelineDefinition;
export function definePipeline(options: PipelineOptions | DurablePipelineOptions): PipelineDefinition {
  if ("mode" in options) return defineDurablePipeline(options);
  const { key, revision, description, maxTransitions = 256 } = options;
  if (!hasText(key) || !hasText(revision) || !hasText(description)) throw new TypeError("A pipeline requires a key, revision and description.");
  if (!Number.isSafeInteger(maxTransitions) || maxTransitions < 0) throw new RangeError("maxTransitions must be a nonnegative safe integer.");
  const steps = prepareSteps(options);
  const stageOrder = [...steps.keys()];
  const firstKey = stageOrder[0]!;
  const inputSchema = schemaCopy(options.inputSchema, "Pipeline input schema");
  const outputSchema = schemaCopy(options.outputSchema, "Pipeline output schema");
  const descriptor = { description, revision, inputSchema, outputSchema, stageOrder };
  const definition = copyJSON({
    key, ...descriptor, maxTransitions, rules: options.rules ?? null,
    steps: [...steps.values()].map(step => ({
      key: step.key, description: step.description ?? "", inputSchema: step.inputSchema, outputSchema: step.outputSchema,
      selectInput: !!step.selectInput, next: typeof step.next === "function" ? { conditional: true } : step.next,
      pauseAfter: step.pauseAfter ?? false, waitUntil: !!step.waitUntil, rules: step.rules ?? null,
    })),
  }, null, "Pipeline definition", "INVALID_INPUT");

  async function createWorkflow(host: PipelineHostContext) {
    host.signal.throwIfAborted();
    const request = copyJSON(host.request, host.checkpoint, "Pipeline request", "INVALID_INPUT");
    assertPipelineValue(inputSchema, request, "Pipeline input");
    const bytes = encode({ format: "atk-pipeline/1", definition, request });
    const digest = sha256(bytes);
    if (host.checkpoint && (host.checkpoint.workflowKey !== key || host.checkpoint.revision !== revision)) {
      throw new DurableExecutionError("WORKFLOW_REVISION_MISMATCH", "The pipeline key or revision differs from the pinned workflow.", host.checkpoint);
    }
    if (host.checkpoint && host.checkpoint.input.sha256 !== digest) {
      throw new DurableExecutionError("INPUT_SNAPSHOT_MISMATCH", "The pipeline request or definition differs from the pinned manifest.", host.checkpoint);
    }
    // Store implementations may issue a fresh ID for identical bytes. On resume use the original reference.
    const ref = host.checkpoint ? manifestRef(host.checkpoint.input) : await host.store.putArtifact("manifest", bytes);
    const input = { manifestId: ref.id, sha256: ref.sha256, snapshotId: digest, artifacts: [] };

    function work(stepKey: string, path: Path, rerun: DurableRerun | null): DurableWork {
      const dependencies = Object.fromEntries(Object.entries(path.outputs).map(([name, entry]) => [name, entry.sha256]));
      const cacheFingerprint = sha256(encode([digest, stepKey, path.previous, path.transitions, dependencies, rerun?.scope ?? null, rerun?.params ?? null]));
      const operationKey = stepKey + "/" + sha256(encode([host.runId, cacheFingerprint, path, rerun?.id ?? null]));
      return { stepKey, operationKey, cacheFingerprint, scope: path };
    }
    function pathOf(scheduled: DurableWork, checkpoint: DurableCheckpoint, rerun: DurableRerun | null): Path {
      const path = scheduled.scope as Path;
      const expected = work(scheduled.stepKey, path, rerun);
      if (expected.cacheFingerprint !== scheduled.cacheFingerprint || expected.operationKey !== scheduled.operationKey) {
        throw new DurableExecutionError("INVALID_WORK", "Scheduled pipeline work differs from its fingerprint.", checkpoint);
      }
      return path;
    }

    const handlers = Object.create(null) as Record<string, DurableStep>;
    for (const step of steps.values()) {
      handlers[step.key] = async durable => {
        const { checkpoint, signal } = durable;
        const rerun = checkpoint.rerun ?? null;
        const path = pathOf(durable.work, checkpoint, rerun);
        const outputs = await getOutputs(path, durable.readArtifact);
        let active = true;
        const context: PipelineStepContext = {
          request: structuredClone(request), outputs, rerun: structuredClone(rerun),
          signal, operationKey: durable.work.operationKey, runId: durable.runId, attemptId: durable.attemptId,
          stepKey: step.key, workDirectory: host.workDirectory,
          reportProgress(update) {
            if (active && !signal.aborted) host.reportProgress({ ...update, attemptId: durable.attemptId, stepKey: step.key });
          },
        };
        try {
          const previous = path.previous === null ? context.request : outputs[path.previous]!;
          const value = step.selectInput ? step.selectInput(previous, context) : previous;
          assertPipelineValue(step.inputSchema, value, step.key + " input");
          signal.throwIfAborted();
          const result = await step.run(value, context);
          signal.throwIfAborted();
          assertPipelineValue(step.outputSchema, result, step.key + " output");
          const target = typeof step.next === "function" ? step.next(structuredClone(result), context) : step.next;
          if (target !== null && (typeof target !== "string" || !steps.has(target))) {
            throw new DurableExecutionError("INVALID_WORK", "Unknown transition target from " + step.key + ".", checkpoint);
          }
          if (target !== null && path.transitions >= maxTransitions) {
            throw new DurableExecutionError("INVALID_WORK", "Pipeline exceeded maxTransitions.", checkpoint);
          }
          if (target === null) assertPipelineValue(outputSchema, result, "Pipeline output");
          const artifact = await durable.putArtifact("pipeline-output/" + step.key, encode(result));
          const next = target === null ? null : work(target, {
            previous: step.key, transitions: path.transitions + 1,
            outputs: { ...path.outputs, [step.key]: { artifactId: artifact.id, sha256: artifact.sha256, checkpointSeq: checkpoint.checkpointSeq + 1 } },
          }, rerun);
          return { outcome: { code: target === null ? "completed" : "ok", detailsRef: artifact.id }, artifacts: [artifact], next };
        } finally {
          active = false;
        }
      };
    }

    return {
      workflow: { workflowKey: key, revision, steps: handlers },
      input, stageOrder: [...stageOrder], first: work(firstKey, { previous: null, outputs: {}, transitions: 0 }, null),
      ...([...steps.values()].some(step => step.pauseAfter || step.waitUntil) ? {
        pauseBeforeFirst: !!steps.get(firstKey)?.waitUntil,
        async pauseBefore({ checkpoint, signal }: { checkpoint: DurableCheckpoint; signal: AbortSignal }) {
          if (checkpoint.checkpointSeq !== host.checkpoint?.checkpointSeq &&
              checkpoint.committed && steps.get(checkpoint.committed.stepKey)?.pauseAfter) return true;
          const pending = checkpoint.next;
          const waitUntil = pending && steps.get(pending.stepKey)?.waitUntil;
          if (!pending || !waitUntil) return false;
          const rerun = checkpoint.rerun ?? null;
          const path = pathOf(pending, checkpoint, rerun);
          const outputs = await getOutputs(path, ref => readVerifiedArtifact(host.store, ref, checkpoint));
          signal.throwIfAborted();
          const ready = await waitUntil({
            checkpoint, signal, outputs, rerun, stepKey: pending.stepKey, operationKey: pending.operationKey,
            request: structuredClone(request), runId: host.runId, workDirectory: host.workDirectory,
          });
          if (typeof ready !== "boolean") throw new TypeError(pending.stepKey + " waitUntil must return a boolean.");
          return !ready;
        },
      } : {}),
      async planRerun({ checkpoint, request: rerun }: { checkpoint: DurableCheckpoint; request: DurableRerun }) {
        const current = checkpoint.next ?? checkpoint.committed;
        if (!current) throw new DurableExecutionError("INVALID_WORK", "No pipeline work is available for rerun.", checkpoint);
        const currentPath = pathOf(current, checkpoint, checkpoint.rerun ?? null);
        if (current.stepKey === rerun.stepKey) return work(rerun.stepKey, currentPath, rerun);
        const entry = Object.hasOwn(currentPath.outputs, rerun.stepKey) ? currentPath.outputs[rerun.stepKey] : undefined;
        const selected = entry && await host.store.readCheckpoint(checkpoint.runId, entry.checkpointSeq);
        if (!selected?.committed || selected.committed.stepKey !== rerun.stepKey || selected.generation !== checkpoint.generation ||
            selected.committed.outcome.detailsRef !== entry?.artifactId) {
          throw new DurableExecutionError("INVALID_WORK", "Rerun requires a step on the selected execution path.", checkpoint);
        }
        return work(rerun.stepKey, pathOf(selected.committed, selected, selected.rerun ?? null), rerun);
      },
    };
  }
  return { key, fingerprint: sha256(encode(definition)), descriptor: structuredClone(descriptor), createWorkflow };
}
