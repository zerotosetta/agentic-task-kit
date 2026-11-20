import { canonicalJSON, copyJSON, DurableExecutionError, hasText, sha256 } from "./durable-validation.js";
import { assertPipelineSchema, assertPipelineValue } from "./pipeline-schema.js";
import type { DurableCheckpoint, DurableStep, DurableWork } from "./types/durable.js";
import type { DurablePipelineDefinition, DurablePipelineOptions, DurablePipelineStep } from "./types/pipeline.js";

export function defineDurablePipeline(options: DurablePipelineOptions): DurablePipelineDefinition {
  const { key, revision, description, bind } = options;
  if (options.mode !== "durable" || !hasText(key) || !hasText(revision) || !hasText(description) || typeof bind !== "function") {
    throw new TypeError("A durable pipeline requires a key, revision, description and bind function.");
  }
  assertPipelineSchema(options.inputSchema, "Pipeline input schema");
  assertPipelineSchema(options.outputSchema, "Pipeline output schema");
  const inputSchema = structuredClone(options.inputSchema);
  const outputSchema = structuredClone(options.outputSchema);
  if (!Array.isArray(options.steps) || !options.steps.length || options.steps.length > 256) {
    throw new TypeError("A pipeline requires 1 to 256 steps.");
  }

  const steps = new Map<string, DurablePipelineStep>();
  for (const step of options.steps) {
    if (!hasText(step?.key) || step.key.length > 256 || steps.has(step.key) || typeof step.run !== "function") {
      throw new TypeError("Every durable pipeline step requires a unique key of up to 256 characters and a run handler.");
    }
    if ((step.internal !== undefined && typeof step.internal !== "boolean") || !Array.isArray(step.allowedNext)) {
      throw new TypeError("Invalid visibility or allowedNext for " + step.key + ".");
    }
    assertPipelineSchema(step.inputSchema, step.key + " input schema");
    assertPipelineSchema(step.outputSchema, step.key + " output schema");
    steps.set(step.key, { key: step.key, internal: step.internal ?? false, run: step.run,
      inputSchema: structuredClone(step.inputSchema), outputSchema: structuredClone(step.outputSchema),
      allowedNext: [...step.allowedNext] });
  }
  for (const step of steps.values()) {
    for (const target of step.allowedNext) {
      if (target !== null && !steps.has(target)) throw new TypeError("Unknown transition target from " + step.key + ".");
    }
  }
  const stageOrder = [...steps.values()].filter(step => !step.internal).map(step => step.key);
  if (!stageOrder.length) throw new TypeError("A durable pipeline requires at least one public stage.");
  const descriptor = { mode: "durable" as const, revision, description, inputSchema, outputSchema, stageOrder,
    steps: [...steps.values()].map(({ run: _run, ...metadata }) => metadata) };
  const definition = copyJSON({ key, ...descriptor }, null, "Pipeline definition", "INVALID_INPUT");
  const fingerprint = sha256(Buffer.from(canonicalJSON(definition)));

  function checkedWork(work: DurableWork, checkpoint: DurableCheckpoint | null): DurableWork {
    const target = steps.get(work?.stepKey);
    if (!target) throw new DurableExecutionError("INVALID_WORK", "Unknown durable pipeline step " + work?.stepKey + ".", checkpoint);
    const scope = work.scope === undefined ? null : work.scope;
    assertPipelineValue(target.inputSchema, scope, target.key + " input");
    return work.scope === undefined ? { ...work, scope } : work;
  }

  return { key, fingerprint, descriptor: structuredClone(descriptor), async createWorkflow(host) {
    host.signal.throwIfAborted();
    if (host.checkpoint && (host.checkpoint.workflowKey !== key || host.checkpoint.revision !== revision)) {
      throw new DurableExecutionError("WORKFLOW_REVISION_MISMATCH", "The pipeline key or revision differs from the pinned workflow.", host.checkpoint);
    }
    assertPipelineValue(inputSchema, host.request, "Pipeline input");
    const binding = await bind(host, fingerprint);
    const handlers = Object.create(null) as Record<string, DurableStep>;
    for (const step of steps.values()) {
      handlers[step.key] = async context => {
        checkedWork(context.work, context.checkpoint);
        const result = await step.run(context);
        context.signal.throwIfAborted();
        const next = result.next === null ? null : checkedWork(result.next, context.checkpoint);
        if (!step.allowedNext.includes(next?.stepKey ?? null)) {
          throw new DurableExecutionError("INVALID_WORK", "Transition from " + step.key + " is not allowed.", context.checkpoint);
        }
        let outcome = result.outcome;
        if (result.reuseFrom !== undefined) {
          const source = context.findReusableWork();
          if (!source || result.reuseFrom !== source.checkpointSeq || source.committed.stepKey !== step.key) {
            throw new DurableExecutionError("INVALID_WORK", "Invalid reuse source for " + step.key + ".", context.checkpoint);
          }
          outcome = source.committed.outcome;
        }
        assertPipelineValue(step.outputSchema, outcome, step.key + " output");
        if (!next) assertPipelineValue(outputSchema, outcome, "Pipeline output");
        return { ...result, next };
      };
    }
    const { prepareNext, planRerun, pauseBefore, pauseBeforeFirst } = binding;
    return {
      workflow: { workflowKey: key, revision, steps: handlers }, stageOrder: [...stageOrder],
      first: checkedWork(binding.first, host.checkpoint), input: binding.input,
      ...(pauseBefore && { pauseBefore }), ...(pauseBeforeFirst !== undefined && { pauseBeforeFirst }),
      ...(prepareNext && { async prepareNext(context) {
        const change = await prepareNext(context);
        return change && { ...change, next: checkedWork(change.next, context.checkpoint) };
      } }),
      ...(planRerun && { async planRerun(context) {
        return checkedWork(await planRerun(context), context.checkpoint);
      } }),
    };
  } };
}
