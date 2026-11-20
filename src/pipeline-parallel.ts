import { join } from "node:path";
import { durableStepInterrupted, isNonRecoverableFailure, normalizeFailure } from "./durable-errors.js";
import { SqliteDurableExecutionStore } from "./durable-store.js";
import { hasText, sha256 } from "./durable-validation.js";
import { runPipeline } from "./pipeline-runner.js";
import type { DurableJSON } from "./types/durable.js";
import type { PipelineDefinition, PipelineStep, PipelineStepContext } from "./types/pipeline.js";

export interface ParallelBranch {
  key: string;
  pipeline: PipelineDefinition;
  /** Map the parent input to the child's pinned request. Must be deterministic across retries. */
  selectInput?(input: DurableJSON, context: PipelineStepContext): DurableJSON;
}

export interface ParallelStepOptions extends Pick<PipelineStep, "key" | "description" | "inputSchema" | "selectInput" | "next" | "pauseAfter"> {
  branches: readonly ParallelBranch[];
  /** Maximum concurrently executing child pipelines. Defaults to four. */
  concurrency?: number;
}

/** Join all named child pipelines. Each parent attempt invokes each child at most once.
 * A paused child leaves the join uncommitted and interrupted. Explicit parent resume
 * continues the child from that boundary. A stage rerun starts a fresh group of children.
 */
export function parallelStep({ branches, concurrency = 4, ...step }: ParallelStepOptions): PipelineStep {
  if (!Array.isArray(branches) || !branches.length || branches.length > 256) throw new TypeError("A parallel step requires 1 to 256 branches.");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) throw new RangeError("concurrency must be between 1 and 64.");
  const names = new Set<string>();
  const children: ParallelBranch[] = [];
  for (const branch of branches) {
    if (!hasText(branch?.key) || branch.key.length > 256 || names.has(branch.key) || !hasText(branch.pipeline?.key)
        || typeof branch.pipeline?.createWorkflow !== "function" || (branch.selectInput !== undefined && typeof branch.selectInput !== "function")) {
      throw new TypeError("Parallel branches require unique keys, a pipeline and an optional input selector.");
    }
    children.push({ ...branch });
    names.add(branch.key);
  }
  const rules = children.map(({ key, pipeline, selectInput }) => ({
    key, pipeline: pipeline.key, revision: pipeline.descriptor.revision, fingerprint: pipeline.fingerprint,
    selectInput: !!selectInput,
  }));
  return {
    ...step,
    rules: { mode: "parallel/1", concurrency, branches: rules },
    outputSchema: {
      type: "object", properties: Object.fromEntries(children.map(b => [b.key, b.pipeline.descriptor.outputSchema])),
      required: [...names], additionalProperties: false,
    },
    async run(input, context) {
      context.signal.throwIfAborted();
      const stateDirectory = join(context.workDirectory, "parallel");
      const store = new SqliteDurableExecutionStore(join(stateDirectory, "execution.sqlite"));
      const outputs: [string, DurableJSON][] = [];
      const errors: { key: string; error: ReturnType<typeof normalizeFailure> }[] = [];
      let interrupted = false;
      let next = 0;
      async function runChildren() {
        while (!context.signal.aborted && next < children.length) {
          const index = next++;
          const child = children[index]!;
          const runId = sha256(Buffer.from(JSON.stringify([context.runId, context.operationKey, child.key])));
          try {
            const current = await store.readRun(runId);
            if (current?.error && isNonRecoverableFailure(current.error)) throw current.error;
            const request = child.selectInput ? child.selectInput(structuredClone(input), {
              ...context, request: structuredClone(context.request), outputs: structuredClone(context.outputs), rerun: structuredClone(context.rerun),
            }) : input;
            const result = await runPipeline(child.pipeline, request, {
              store, stateDirectory, runId, signal: context.signal,
              ...(current ? { resume: true, expectedCheckpointSeq: current.checkpoint.checkpointSeq } : {}),
            });
            if (result.error) throw result.error;
            if (result.status === "interrupted") {
              interrupted = true;
              continue;
            }
            if (result.status !== "completed" || result.output === undefined) throw new Error("Child did not produce a pipeline output.");
            outputs[index] = [child.key, result.output];
          } catch (error) {
            errors[index] = { key: child.key, error: normalizeFailure(error, "PARALLEL_BRANCH_FAILED") };
          }
        }
      }
      try {
        await Promise.all(Array.from({ length: Math.min(concurrency, children.length) }, runChildren));
        context.signal.throwIfAborted();
        const failures = errors.filter(Boolean);
        if (failures.length) {
          const message = failures.map(({ key, error }) => key + ": " + (error.cause?.message ?? error.message)).join("\n");
          throw Object.assign(new Error(message), {
            code: "PARALLEL_BRANCH_FAILED",
            recoverable: !failures.some(({ error }) => isNonRecoverableFailure(error)),
          });
        }
        if (interrupted) throw durableStepInterrupted;
        return Object.fromEntries(outputs);
      } finally {
        store.close();
      }
    },
  };
}
