import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SqliteDurableExecutionStore } from "../src/durable-store.js";
import { readResults } from "../src/mcp/results.js";
import { runPipeline } from "../src/pipeline.js";
import { createAgentPipeline, planPipeline, validatePipelinePlan, type AgentPipelineOptions, type PipelinePlan, type PipelineOperation } from "../src/pipeline-planner.js";
import type { AIProvider } from "../src/types/ai.js";
import type { PipelineSchema } from "../src/pipeline-schema.js";

const string = { type: "string" } as const;
function object(properties: Record<string, PipelineSchema>): PipelineSchema {
  return { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
}

const request = { goal: "Produce the uppercase label", label: "kit" };
const lookup = { id: "load", operation: "lookup", args: { label: { from: "request", path: ["label"] } } } as const;
const render = { id: "present", operation: "format", args: { label: { from: "step", step: "load", path: ["label"] } } } as const;
const plan = { steps: [lookup, render], result: { from: "step", step: "present", path: ["message"] } } as const;

function options(overrides: Partial<AgentPipelineOptions> = {}): AgentPipelineOptions {
  const operations: PipelineOperation[] = [
    { key: "lookup", revision: "1", description: "Find the label", effect: "read",
      inputSchema: object({ label: string }), outputSchema: object({ label: string }), run: input => input },
    { key: "format", revision: "1", description: "Format a label", effect: "read", inputSchema: object({ label: string }),
      outputSchema: object({ message: string }), run: input => ({ message: (input as {label: string}).label.toUpperCase() }) },
    { key: "publish", revision: "1", description: "Publish a label", effect: "write", inputSchema: object({ label: string }),
      outputSchema: object({ label: string }), run: input => input },
  ];
  return { key: "labels", description: "Format the requested label", revision: "1", inputSchema: object({ goal: string, label: string }),
    outputSchema: string, operations, ...overrides };
}

describe("agent pipeline planning", () => {
  it("uses an ATK provider, exposes only permitted operations and repairs one invalid reply", async () => {
    const chat = vi.fn<AIProvider["chat"]>().mockImplementation(async call => {
      const user = JSON.parse(call.messages![1]!.content as string);
      expect(user.goal).toBe(request.goal);
      expect(user.operations.map((op: PipelineOperation) => op.key)).toEqual(["lookup", "format"]);
      expect(user.operations[0]).not.toHaveProperty("run");
      if (user.attempt === 2) expect(user.validationError).toMatch(/plan|JSON|unexpected/i);
      const outputText = user.attempt === 1 ? "}" : JSON.stringify(plan);
      return { provider: "test", model: "test", outputText, message: { role: "assistant", content: outputText } };
    });
    const aiProvider: AIProvider = { provider: "test", chat, chatStream: vi.fn() };
    const result = await planPipeline(options({ aiProvider }), request);
    expect(result).toEqual(plan);
    expect(Object.isFrozen(result.steps[0]!.args)).toBe(true);
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("fails before execution for unknown operations, forbidden effects, cycles and broken contracts", () => {
    const host = options();
    const run = vi.spyOn(host.operations[0]!, "run");
    const change = (step: unknown) => ({ steps: [lookup, step], result: plan.result });
    const withArg = (ref: unknown) => change({ ...render, args: { label: ref } });
    for (const [candidate, reason] of [
      [change({ ...render, operation: "run-shell" }), /unknown operation/i],
      [change({ ...render, operation: "publish" }), /disallowed effect/i],
      [change({ ...render, exec: "command" }), /unexpected step field/i],
      [withArg({ from: "step", step: "present" }), /preceding step/i],
      [{ steps: [render, lookup], result: plan.result }, /preceding step/i],
      [withArg({ from: "step", step: "load" }), /incompatible source/i],
      [withArg({ from: "request", path: ["toString"] }), /absent or optional/i],
      [change({ ...render, args: {} }), /requires argument/i],
      [withArg({ value: 0 }), /string/i],
      [{ ...plan, result: { from: "step", step: "load" } }, /incompatible source/i],
      [change({ ...render, id: "load" }), /duplicate step/i],
      [change({ ...render, args: { ...render.args, url: { value: "endpoint" } } }), /unknown argument/i],
    ] as const) expect(() => validatePipelinePlan(candidate, host)).toThrow(reason);
    expect(() => validatePipelinePlan(plan, options({ maxSteps: 1 }))).toThrow(/between 1 and 1/);
    expect(() => validatePipelinePlan(" ".repeat(65537), host)).toThrow(/64 KiB/);
    expect(run).not.toHaveBeenCalled();
  });

  it("requires explicit permission for effects and respects runtime cancellation and retry bounds", async () => {
    const publish = { steps: [{ ...lookup, operation: "publish" }], result: { from: "step", step: "load", path: ["label"] } };
    expect(validatePipelinePlan(publish, options({ allowedEffects: ["write"] }))).toEqual(publish);
    const planner = vi.fn(() => ({}));
    await expect(planPipeline(options({ planner }), request)).rejects.toThrow(/exhausted 2/);
    expect(planner).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort(new Error("cancel now"));
    await expect(planPipeline(options({ planner }), request, controller.signal)).rejects.toThrow("cancel now");
    expect(planner).toHaveBeenCalledTimes(2);
    await expect(planPipeline(options({ planner }), { ...request, goal: " " })).rejects.toThrow(/nonblank goal/);
  });

  it("checks contract narrowing, optional fields, nested schemas and enum-specific literals", () => {
    const host = options();
    const viaLabel = (label: PipelineSchema, expected: PipelineSchema) => {
      const operations = host.operations.map(op => op.key === "lookup" ? { ...op, outputSchema: object({ label }) } :
        op.key === "format" ? { ...op, inputSchema: object({ label: expected }) } : op);
      return () => validatePipelinePlan(plan, { ...host, operations });
    };
    expect(viaLabel({ type: "integer" }, { type: "number" })).not.toThrow();
    expect(viaLabel({ type: "number" }, { type: "integer" })).toThrow(/incompatible/);
    expect(viaLabel({ type: "string", enum: ["a"] }, { type: "string", enum: ["a", "b"] })).not.toThrow();
    expect(viaLabel({ type: "string" }, { type: "string", enum: ["a"] })).toThrow(/incompatible/);
    expect(viaLabel({ type: "array", items: string }, { type: "array", items: { type: "number" } })).toThrow(/incompatible/);
    expect(viaLabel({ type: "object" }, object({}))).toThrow(/incompatible/);
    const inputSchema = { ...host.inputSchema, required: ["goal"] };
    expect(() => validatePipelinePlan(plan, { ...host, inputSchema })).toThrow(/optional property/);
  });

  it("restores the pinned plan on resume and rejects a different operation revision before execution", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "atk-agent-pipeline-"));
    const store = new SqliteDurableExecutionStore(join(stateDirectory, "execution.sqlite"));
    try {
      const planner = vi.fn((): PipelinePlan => plan);
      const host = options({ planner });
      const agent = createAgentPipeline(host);
      expect(agent.descriptor.stageOrder).toBeUndefined();
      const run = await runPipeline(agent, request, { store, stateDirectory, maxSteps: 1 });
      expect(run.status).toBe("interrupted");
      expect(run.checkpoint.next?.stepKey).toBe("present");
      const signal = new AbortController().signal;
      const list = await readResults(store, run.runId, run, {}, signal);
      if (!("artifacts" in list)) throw new Error("Expected artifact metadata.");
      const ref = list.artifacts.find(item => item.kind === "pipeline-plan")!;
      const downloaded = await readResults(store, run.runId, run, { artifactId: ref.id }, signal);
      if (!("data" in downloaded)) throw new Error("Expected artifact bytes.");
      const receipt = JSON.parse(Buffer.from(downloaded.data, "base64").toString("utf8"));
      expect(receipt).toMatchObject({ plan, operations: { format: { revision: "1" }, lookup: { revision: "1" } } });
      expect(receipt).not.toHaveProperty("request");
      const neverPlan = vi.fn(() => { throw new Error("unexpected replanning"); });
      const resumeOptions = { store, stateDirectory, runId: run.runId, resume: true };
      const changed = host.operations.map(op => op.key === "format" ? { ...op, revision: "2" } : op);
      await expect(runPipeline(createAgentPipeline({ ...host, operations: changed, planner: neverPlan }), request, resumeOptions))
        .rejects.toThrow(/operation revision/i);
      const reclassified = host.operations.map(op => op.key === "format" ? { ...op, effect: "write" as const } : op);
      const changedOutput = host.operations.map(op => op.key === "format"
        ? { ...op, outputSchema: object({ message: string, extra: string }) } : op);
      for (const operations of [reclassified, changedOutput]) {
        const modified = createAgentPipeline({ ...host, operations, allowedEffects: ["read", "write"], planner: neverPlan });
        await expect(runPipeline(modified, request, resumeOptions)).rejects.toMatchObject({ code: "WORKFLOW_REVISION_MISMATCH" });
      }
      const done = await runPipeline(createAgentPipeline({ ...host, planner: neverPlan }), request, resumeOptions);
      expect(done.status).toBe("completed");
      expect(done.output).toBe("KIT");
      const rerun = await runPipeline(agent, request, { ...resumeOptions, rerun: {
        id: "repeat", stepKey: "load", expectedCheckpointSeq: done.checkpoint.checkpointSeq, scope: {}, params: {},
      } });
      const repeated = await readResults(store, run.runId, rerun, {}, signal);
      if (!("artifacts" in repeated)) throw new Error("Expected artifact metadata.");
      expect(repeated.artifacts.filter(item => item.kind === "pipeline-plan")).toEqual([ref]);
      expect(planner).toHaveBeenCalledTimes(1);
      expect(neverPlan).not.toHaveBeenCalled();
    } finally {
      store.close();
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  });

  it("accepts a host-submitted plan without a provider and pins its full envelope for resume", async () => {
    const stateDirectory = mkdtempSync(join(tmpdir(), "atk-submitted-pipeline-"));
    const store = new SqliteDurableExecutionStore(join(stateDirectory, "execution.sqlite"));
    try {
      const host = options();
      const first = vi.spyOn(host.operations[0]!, "run");
      const agent = createAgentPipeline(host);
      expect(agent.fromPlan.descriptor.operations?.map(operation => operation.key)).toEqual(["lookup", "format"]);
      expect(agent.fromPlan.descriptor.operations).toEqual(agent.descriptor.operations);
      expect(agent.fromPlan.descriptor.operations![0]).not.toHaveProperty("run");
      expect(agent.fromPlan.descriptor.inputSchema.required).toEqual(["input", "plan"]);
      const envelope = { input: request, plan };
      const invalid = { ...plan, steps: [lookup, { ...render, operation: "publish" }] };
      await expect(runPipeline(agent.fromPlan, { ...envelope, plan: invalid }, { store, stateDirectory })).rejects.toThrow(/disallowed/i);
      await expect(runPipeline(agent.fromPlan, { ...envelope, handlers: {} }, { store, stateDirectory })).rejects.toThrow(/unexpected/i);
      expect(first).not.toHaveBeenCalled();
      const run = await runPipeline(agent.fromPlan.createWorkflow, envelope, { store, stateDirectory, maxSteps: 1 });
      expect(run.status).toBe("interrupted");
      expect(first.mock.calls[0]?.[1].request).toEqual(request);
      const resume = { store, stateDirectory, runId: run.runId, resume: true };
      const changed = { ...plan, steps: [lookup, { ...render, args: { label: { value: "substitute" } } }] };
      await expect(runPipeline(agent.fromPlan, { ...envelope, plan: changed }, resume))
        .rejects.toMatchObject({ code: "INPUT_SNAPSHOT_MISMATCH" });
      const done = await runPipeline(agent.fromPlan, envelope, resume);
      expect(done.output).toBe("KIT");
      expect(first).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  });
});
