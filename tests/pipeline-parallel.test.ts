import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { definePipeline, runPipeline } from "../src/pipeline.js";
import { parallelStep, type ParallelBranch } from "../src/pipeline-parallel.js";
import type { PipelineStep } from "../src/types/pipeline.js";

const stringSchema = { type: "string" } as const;
const objectSchema = { type: "object" } as const;
let stateDirectory: string;
beforeEach(async () => { stateDirectory = await mkdtemp(join(tmpdir(), "atk-parallel-")); });
afterEach(async () => { await rm(stateDirectory, { recursive: true, force: true, maxRetries: 5 }); });

function stringStep(key: string, run: PipelineStep["run"], pauseAfter = false): PipelineStep {
  return { key, inputSchema: stringSchema, outputSchema: stringSchema, run, pauseAfter };
}
function child(key: string, steps: PipelineStep[], revision = "1"): ParallelBranch {
  const pipeline = definePipeline({ key, description: key, revision, inputSchema: stringSchema, outputSchema: stringSchema, steps });
  return { key, pipeline };
}
function parent(branches: ParallelBranch[], pauseAfter = false) {
  return definePipeline({
    key: "parent", description: "join children", revision: "1", inputSchema: stringSchema, outputSchema: objectSchema,
    steps: [parallelStep({ key: "join", branches, inputSchema: stringSchema, concurrency: 2, pauseAfter })],
  });
}

describe("durable parallelStep", () => {
  it("bounds concurrency, joins all branches, retries only incomplete work and starts fresh children for a rerun", async () => {
    const prepared: string[] = [];
    const calls: { key: string; id: string; operation: string }[] = [];
    let active = 0, peak = 0, fail = true;
    const pipeline = parent(["a", "b", "c"].map(key => ({
      ...child(key, [
        stringStep("prepare", input => { prepared.push(key); return input; }),
        stringStep("work", async (input, ctx) => {
          calls.push({ key, id: ctx.runId, operation: ctx.operationKey });
          peak = Math.max(peak, ++active);
          try {
            await delay(15);
            if (key === "b" && fail) throw new Error("source offline");
            return input;
          } finally { active--; }
        }),
      ]),
      selectInput: input => String(input) + key,
    })));
    const options = { runId: "parent/test", stateDirectory };
    const failed = await runPipeline(pipeline, "x", options);
    expect(failed.status).toBe("failed");
    expect(failed.error?.cause).toMatchObject({ code: "PARALLEL_BRANCH_FAILED", message: "b: source offline" });
    expect(failed.checkpoint.checkpointSeq).toBe(0);
    expect(calls.map(c => c.key).sort()).toEqual(["a", "b", "c"]);
    expect(peak).toBe(2);

    fail = false;
    const resumed = await runPipeline(pipeline, "x", { ...options, resume: true });
    expect(resumed.output).toEqual({ a: "xa", b: "xb", c: "xc" });
    const attempts = calls.filter(c => c.key === "b");
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    expect(calls).toHaveLength(4);
    expect(prepared.sort()).toEqual(["a", "b", "c"]);

    const rerun = { id: "redo", expectedCheckpointSeq: resumed.checkpoint.checkpointSeq, stepKey: "join", scope: {}, params: {} };
    const reran = await runPipeline(pipeline, "x", { ...options, rerun });
    expect(reran.output).toEqual(resumed.output);
    expect(new Set(calls.map(c => c.id)).size).toBe(6);
    expect(prepared.sort()).toEqual(["a", "a", "b", "b", "c", "c"]);
  });

  it("pauses an uncommitted join at every child approval boundary until explicit parent resume", async () => {
    const stages: string[] = [];
    const pipeline = parent([
      child("gated", ["first", "second", "last"].map(key => stringStep(key, input => {
        stages.push(key);
        return input;
      }, key !== "last"))),
      child("sibling", [stringStep("once", input => { stages.push("sibling"); return input; })]),
    ], true);
    const options = { stateDirectory, runId: "gated-parent" };
    const first = await runPipeline(pipeline, "hello", options);
    expect(first).toMatchObject({ status: "interrupted", checkpoint: { checkpointSeq: 0, next: { stepKey: "join" } }, error: null });
    expect([...stages].sort()).toEqual(["first", "sibling"]);
    const second = await runPipeline(pipeline, "hello", { ...options, resume: true });
    expect(second).toMatchObject({ status: "interrupted", checkpoint: { checkpointSeq: 0 }, error: null });
    expect([...stages].sort()).toEqual(["first", "second", "sibling"]);
    const last = await runPipeline(pipeline, "hello", { ...options, resume: true });
    expect(last.output).toEqual({ gated: "hello", sibling: "hello" });
    expect([...stages].sort()).toEqual(["first", "last", "second", "sibling"]);
  });

  it("forwards cancellation, drains active children, and leaves queued branches for a later resume", async () => {
    let block = true;
    const started: string[] = [];
    const aborted: string[] = [];
    const pipeline = parent(["a", "b", "c"].map(key => child(key, [
      stringStep("run", async (input, ctx) => {
        started.push(key);
        if (block) {
          try { await delay(30_000, undefined, { signal: ctx.signal }); }
          finally { if (ctx.signal.aborted) aborted.push(key); }
        }
        return input;
      }),
    ])));
    const options = { stateDirectory, runId: "cancel-parent" };
    const controller = new AbortController();
    const running = runPipeline(pipeline, "value", { ...options, signal: controller.signal });
    await expect.poll(() => started.length).toBe(2);
    controller.abort(new Error("stop"));
    expect((await running).status).toBe("cancelled");
    expect(aborted.sort()).toEqual(["a", "b"]);
    expect(started.sort()).toEqual(["a", "b"]);
    block = false;
    const resumed = await runPipeline(pipeline, "value", { ...options, resume: true });
    expect(resumed.output).toEqual({ a: "value", b: "value", c: "value" });
    expect(started.sort()).toEqual(["a", "a", "b", "b", "c"]);
  });

  it("pins branch revisions and rejects invalid or duplicate branch declarations", async () => {
    const build = (revision: string, rule = "original") => parent([
      child("one", [{ ...stringStep("run", input => input), rules: { rule } }], revision),
    ]);
    const options = { stateDirectory, runId: "pin-test" };
    await runPipeline(build("original"), "x", options);
    await expect(runPipeline(build("changed"), "x", { ...options, resume: true })).rejects.toMatchObject({ code: "INPUT_SNAPSHOT_MISMATCH" });
    await expect(runPipeline(build("original", "new-rules"), "x", { ...options, resume: true })).rejects.toMatchObject({ code: "INPUT_SNAPSHOT_MISMATCH" });
    const branch = child("same", [stringStep("run", input => input)]);
    expect(() => parent([branch, branch])).toThrow("unique keys");
    expect(() => parallelStep({ key: "join", inputSchema: stringSchema, branches: [branch], concurrency: 0 })).toThrow("concurrency");
  });
});
