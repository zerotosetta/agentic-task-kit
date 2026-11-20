import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { durableStepInterrupted } from "../src/durable-errors.js";
import { SqliteDurableExecutionStore } from "../src/durable-store.js";
import { definePipeline, readPinnedPipelineRules, runPipeline, type PipelineOptions, type PipelineStepContext } from "../src/pipeline.js";

const string = { type: "string" } as const;
const object = { type: "object" } as const;
const echo = { key: "echo", inputSchema: string, outputSchema: string, run: (value: unknown) => String(value) };
function options(overrides: Partial<PipelineOptions> = {}): PipelineOptions {
  return { key: "example", description: "Echo text", revision: "v1", inputSchema: string, outputSchema: string, steps: [echo], ...overrides };
}

let stateDirectory: string;
beforeEach(() => { stateDirectory = mkdtempSync(join(tmpdir(), "atk-pipeline-test-")); });
afterEach(() => { rmSync(stateDirectory, { recursive: true, force: true }); });

describe("pipeline authoring and execution", () => {
  it("waits at checkpoint zero and rechecks external prerequisites on every invocation and rerun", async () => {
    let firstReady = false;
    let lastReady = false;
    const run = vi.fn((input: unknown) => String(input));
    const pipeline = definePipeline(options({ steps: [
      { ...echo, key: "first", waitUntil: () => firstReady, pauseAfter: true, run },
      { ...echo, key: "last", run, async waitUntil(ctx) {
        expect(ctx.outputs).toEqual({ first: "go" });
        expect(ctx.request).toBe("go");
        return lastReady;
      } },
    ] }));
    const first = await runPipeline(pipeline, "go", { stateDirectory });
    expect(first.status).toBe("interrupted");
    expect(first.checkpoint.checkpointSeq).toBe(0);
    const resume = { stateDirectory, runId: first.runId, resume: true };
    expect((await runPipeline(pipeline, "go", resume)).checkpoint).toEqual(first.checkpoint);
    expect(run).not.toHaveBeenCalled();
    firstReady = true;
    const paused = await runPipeline(pipeline, "go", resume);
    expect(paused.checkpoint.next?.stepKey).toBe("last");
    expect((await runPipeline(pipeline, "go", resume)).checkpoint).toEqual(paused.checkpoint);
    expect(run).toHaveBeenCalledTimes(1);
    lastReady = true;
    expect((await runPipeline(pipeline, "go", resume)).output).toBe("go");
    lastReady = false;
    const rerun = { id: "again", stepKey: "last", expectedCheckpointSeq: 2, scope: {}, params: {} };
    const gated = await runPipeline(pipeline, "go", { ...resume, rerun });
    expect(gated.checkpoint.checkpointSeq).toBe(3);
    expect(gated.status).toBe("interrupted");
    expect((await runPipeline(pipeline, "go", { ...resume, rerun })).checkpoint).toEqual(gated.checkpoint);
    expect(run).toHaveBeenCalledTimes(2);
    lastReady = true;
    expect((await runPipeline(pipeline, "go", resume)).output).toBe("go");
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("yields a pending child join without spinning, then records the linked retry", async () => {
    let ready = false;
    const store = new SqliteDurableExecutionStore(join(stateDirectory, "execution.sqlite"));
    try {
      const pipeline = definePipeline(options({ steps: [
        { ...echo, waitUntil: () => true, run(input) { if (!ready) throw durableStepInterrupted; return input; } },
      ] }));
      const paused = await runPipeline(pipeline, "go", { store, stateDirectory });
      expect(paused).toMatchObject({ status: "interrupted", checkpoint: { checkpointSeq: 0, committed: null }, error: null });
      expect((await store.readRun(paused.runId))?.status).toBe("interrupted");
      const attempts = await store.listAttempts(paused.runId);
      expect(attempts).toHaveLength(1);
      expect(attempts[0]?.status).toBe("interrupted");
      ready = true;
      const resumed = await runPipeline(pipeline, "go", { store, stateDirectory, runId: paused.runId, resume: true });
      expect(resumed.output).toBe("go");
      expect(resumed.checkpoint.committed?.previousAttemptId).toBe(attempts[0]?.attemptId);
    } finally { store.close(); }
  });

  it("pins its descriptor and input, reports progress against each attempt and resumes from a fresh store", async () => {
    let staleProgress: PipelineStepContext["reportProgress"] | undefined;
    const calls: string[] = [];
    const reportProgress = vi.fn();
    const definition = options({
      inputSchema: object, rules: { policy: 4 }, steps: [
        { key: "load", inputSchema: object, outputSchema: string, pauseAfter: true, run(input, ctx) {
          calls.push(ctx.stepKey);
          staleProgress = ctx.reportProgress;
          ctx.reportProgress({ completed: 1, total: 1 });
          expect(input).toEqual({ name: "Kit", active: true });
          return "hello";
        } },
        { ...echo, key: "render", run(input, ctx) {
          calls.push(ctx.stepKey);
          expect(ctx.request).toEqual({ name: "Kit", active: true });
          expect(ctx.outputs).toEqual({ load: "hello" });
          return input + " Kit";
        } },
      ],
    });
    const pipeline = definePipeline(definition);
    expect(JSON.parse(JSON.stringify(pipeline.descriptor))).toEqual({
      description: "Echo text", revision: "v1", inputSchema: object, outputSchema: string, stageOrder: ["load", "render"],
    });
    const run = await runPipeline(pipeline, { name: "Kit", active: true }, { stateDirectory, reportProgress });
    expect(run.status).toBe("interrupted");
    expect(run.checkpoint.next?.stepKey).toBe("render");
    expect(reportProgress.mock.calls).toEqual([[{ completed: 1, total: 1, attemptId: run.checkpoint.committed?.attemptId, stepKey: "load" }]]);
    staleProgress!({ message: "stale" });
    expect(reportProgress).toHaveBeenCalledTimes(1);
    const store = new SqliteDurableExecutionStore(join(stateDirectory, "execution.sqlite"));
    try {
      expect(await readPinnedPipelineRules(store, run.checkpoint)).toEqual({ policy: 4 });
    } finally { store.close(); }
    const resume = { stateDirectory, runId: run.runId, resume: true, expectedCheckpointSeq: 1 };
    await expect(runPipeline(pipeline, { name: "Other" }, resume)).rejects.toMatchObject({ code: "INPUT_SNAPSHOT_MISMATCH" });
    await expect(runPipeline(definePipeline({ ...definition, rules: { policy: 5 } }), { name: "Kit", active: true }, resume))
      .rejects.toMatchObject({ code: "INPUT_SNAPSHOT_MISMATCH" });
    const done = await runPipeline(definePipeline(definition), { active: true, name: "Kit" }, resume);
    expect(done.output).toBe("hello Kit");
    expect(calls).toEqual(["load", "render"]);
    expect(done.checkpoint.input).toEqual(run.checkpoint.input);
    expect(done.checkpoint.committed?.outcome.detailsRef).toBe(done.checkpoint.committed?.artifacts[0]?.id);
    await expect(runPipeline(pipeline, { active: true, name: "Kit" }, resume)).rejects.toMatchObject({ code: "CHECKPOINT_CONFLICT" });
  });

  it("reruns from the selected step's original dependencies and discards outputs of a superseded branch", async () => {
    const calls: string[] = [];
    const pipeline = definePipeline(options({ steps: [
      { ...echo, key: "route", run(input, ctx) { calls.push(ctx.stepKey); return input; },
        next: (_out, ctx) => ctx.rerun?.params.newRoute === true ? "right" : "left" },
      { ...echo, key: "left", run(_input, ctx) { calls.push(ctx.stepKey); return "L"; }, next: "join" },
      { ...echo, key: "right", run(_input, ctx) { calls.push(ctx.stepKey); return "R"; } },
      { ...echo, key: "join", run(input, ctx) {
        calls.push(ctx.stepKey);
        return input + ":" + Object.keys(ctx.outputs).sort().join(",");
      } },
    ] }));
    const first = await runPipeline(pipeline, "go", { stateDirectory });
    expect(first.output).toBe("L:left,route");
    const rerun = { id: "switch", expectedCheckpointSeq: 3, stepKey: "route", scope: {}, params: { newRoute: true } };
    const retry = { stateDirectory, runId: first.runId, rerun };
    const second = await runPipeline(pipeline, "go", retry);
    expect(second.output).toBe("R:right,route");
    expect(second.checkpoint.checkpointSeq).toBe(7);
    expect((await runPipeline(pipeline, "go", retry)).output).toBe(second.output);
    expect(calls).toEqual(["route", "left", "join", "route", "right", "join"]);
    await expect(runPipeline(pipeline, "go", { ...retry, rerun: { ...rerun, id: "stale-branch", stepKey: "left", expectedCheckpointSeq: 7 } }))
      .rejects.toMatchObject({ code: "INVALID_WORK" });
    await expect(runPipeline(pipeline, "go", { ...retry, rerun: { ...rerun, params: { newRoute: false } } }))
      .rejects.toMatchObject({ code: "CHECKPOINT_CONFLICT" });
  });

  it("checks supplied and derived inputs, step outputs and terminal output with no invalid artifact published", async () => {
    const run = vi.fn(() => 3);
    const badBinding = definePipeline(options({ steps: [{ ...echo, selectInput: () => 1, run }] }));
    await expect(runPipeline(badBinding, 1, { stateDirectory })).rejects.toThrow(/Pipeline input/);
    const failed = await runPipeline(badBinding, "ok", { stateDirectory });
    expect(failed.error?.message).toMatch(/echo input/);
    expect(run).not.toHaveBeenCalled();
    const badOutput = await runPipeline(definePipeline(options({ steps: [{ ...echo, run }] })), "ok", { stateDirectory });
    expect(badOutput.error?.message).toMatch(/echo output/);
    expect(badOutput.checkpoint.committed).toBeNull();
    const badTerminal = await runPipeline(definePipeline(options({ outputSchema: object })), "ok", { stateDirectory });
    expect(badTerminal.error?.message).toMatch(/Pipeline output/);
    expect(badTerminal.checkpoint.committed).toBeNull();
  });

  it("validates static routes at declaration and bounds computed transitions across restarts", async () => {
    expect(() => definePipeline(options({ steps: [echo, echo] }))).toThrow(/unique/);
    expect(() => definePipeline(options({ steps: [{ ...echo, next: "missing" }] }))).toThrow(/unknown/i);
    const unknown = await runPipeline(definePipeline(options({ steps: [{ ...echo, next: () => "missing" }] })), "go", { stateDirectory });
    expect(unknown.error?.code).toBe("INVALID_WORK");
    const cycle = definePipeline(options({ maxTransitions: 2, steps: [{ ...echo, next: () => "echo" }] }));
    const one = await runPipeline(cycle, "go", { stateDirectory, maxSteps: 1 });
    const limit = await runPipeline(cycle, "go", { stateDirectory, runId: one.runId, resume: true });
    expect(limit.checkpoint.checkpointSeq).toBe(2);
    expect(limit.error?.message).toMatch(/maxTransitions/);
    expect(limit.checkpoint.committed?.operationKey).not.toBe(one.checkpoint.committed?.operationKey);
  });

  it("fingerprints content independently of artifact IDs and distinguishes independent side effects", async () => {
    const pipeline = definePipeline(options({ steps: [echo, { ...echo, key: "final" }] }));
    const run = () => runPipeline(pipeline, "same", { stateDirectory });
    const first = await run();
    const second = await run();
    expect(first.checkpoint.input.manifestId).not.toBe(second.checkpoint.input.manifestId);
    expect(first.checkpoint.committed?.cacheFingerprint).toBe(second.checkpoint.committed?.cacheFingerprint);
    expect(first.checkpoint.committed?.operationKey).not.toBe(second.checkpoint.committed?.operationKey);
    const different = await runPipeline(pipeline, "changed", { stateDirectory });
    expect(different.checkpoint.committed?.cacheFingerprint).not.toBe(first.checkpoint.committed?.cacheFingerprint);
  });

  it("honors cancellation before publishing, then retries the same logical operation using a new attempt", async () => {
    const controller = new AbortController();
    const identities: string[][] = [];
    const pipeline = definePipeline(options({ steps: [{ ...echo, async run(input, ctx) {
      identities.push([ctx.runId, ctx.operationKey, ctx.attemptId]);
      if (identities.length === 1) {
        controller.abort(new Error("stop"));
        ctx.signal.throwIfAborted();
      }
      return input;
    } }] }));
    const stopped = await runPipeline(pipeline, "ok", { stateDirectory, signal: controller.signal });
    expect(stopped.status).toBe("cancelled");
    expect(stopped.checkpoint.committed).toBeNull();
    const resumed = await runPipeline(pipeline, "ok", { stateDirectory, runId: stopped.runId, resume: true });
    expect(resumed.output).toBe("ok");
    expect(identities[1]?.slice(0, 2)).toEqual(identities[0]?.slice(0, 2));
    expect(identities[1]?.[2]).not.toBe(identities[0]?.[2]);
  });
});
