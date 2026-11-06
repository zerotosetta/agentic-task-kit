import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AGENT_PROTOCOL_VERSION, createCycle, createWorkflowInput, FileAgentSessionStore, InMemoryAgentSessionStore, InMemoryMemoryEngine, parseAgentReply, runAgentSession,
  type AgentSessionOptions, type AgentTurn, type AgentDataRequest } from "../src/index.js";

const scope = { workflowId: "workflow-A", runId: "run-A", taskId: "analysis" };
const envelope = (turn: AgentTurn, type: string, fields: object) => ({ protocolVersion: AGENT_PROTOCOL_VERSION, type,
  sessionId: turn.sessionId, inReplyTo: turn.turnId, contextVersion: turn.contextVersion, ...fields });
const request = (requestId = "r1", selector = { id: "TASK_A" }): AgentDataRequest => ({ requestId, kind: "task_metadata", selector, reason: "Explain the transaction." });
function options(overrides: Partial<AgentSessionOptions<string>> = {}): AgentSessionOptions<string> {
  return { scope, sessionId: "test-session", seed: { sourceHash: "snapshot-A" },
    buildContext: state => ({ evidence: state.exchanges.map(item => item.response.data ?? null) }),
    invoke: async turn => envelope(turn, "analysis_result", { result: { text: "complete" } }),
    resolve: async item => ({ requestId: item.requestId, status: "provided", evidenceIds: ["F1"], data: { text: "metadata" } }),
    validateResult: value => {
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.text !== "string") throw new Error("Missing text.");
      return value.text;
    }, ...overrides };
}
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(join(resolve(tmpdir()), "atk-agent-test-"))) throw new Error("Invalid test cleanup target.");
    await rm(directory, { recursive: true, force: true });
  }
});
describe("ATK agent session harness", () => {
  it("binds Task runAgent sessions to the actual workflow/run/task", async () => {
    const cycle = createCycle(); let observed: AgentTurn | undefined;
    cycle.register("agent", { name: "agent", start: "analyze", tasks: { analyze: { name: "analyze", memoryPhase: "EXECUTION", memoryTaskType: "workflow",
      async run(ctx) {
        const configuration = options();
        const { scope: _scope, ...session } = configuration;
        const result = await ctx.runAgent({ ...session, invoke: async turn => { observed = turn; return envelope(turn, "analysis_result", { result: { text: "bound" } }); } });
        return { status: "success", output: result.result };
      } } }, transitions: { analyze: "end" } });
    const run = await cycle.run("agent", createWorkflowInput({ pageId: "PAGE_A" }));
    expect(run.frame.status).toBe("success");
    expect(observed).toMatchObject({ runId: run.frame.runId, workflowId: run.frame.workflowId, taskId: "analyze" });
  });
  it("collects host data and finishes with correlated, versioned model turns", async () => {
    const turns: AgentTurn[] = [];
    const result = await runAgentSession(options({ invoke: async turn => {
      turns.push(turn);
      return turn.round === 1 ? envelope(turn, "need_context", { requests: [request()] }) : envelope(turn, "analysis_result", { result: { text: "done" } });
    } }));
    expect(result.result).toBe("done");
    expect(turns.map(turn => [turn.type, turn.contextVersion])).toEqual([["analysis_request", 1], ["context_update", 2]]);
    expect(turns[1]?.responses[0]?.evidenceIds).toEqual(["F1"]);
    expect(result.state.status).toBe("complete");
  });
  it("reviews an initial draft and returns validation errors for correction", async () => {
    const turns: AgentTurn[] = [];
    const result = await runAgentSession(options({ limits: { minRounds: 2 }, invoke: async turn => {
      turns.push(turn);
      return envelope(turn, "analysis_result", { result: turn.round === 2 ? {} : { text: "checked" } });
    } }));
    expect(result.result).toBe("checked");
    expect(turns[1]?.feedback?.code).toBe("REVIEW_REQUIRED");
    expect(turns[2]?.feedback?.code).toBe("RESULT_VALIDATION");
  });
  it("rejects stale context, wrong session/turn, unknown fields and duplicate request IDs", async () => {
    await runAgentSession(options({ invoke: async turn => {
      for (const patch of [{ contextVersion: 0 }, { sessionId: "other" }, { inReplyTo: "other" }, { tool: "shell" }])
        expect(() => parseAgentReply({ ...envelope(turn, "analysis_result", { result: null }), ...patch }, turn)).toThrow();
      expect(() => parseAgentReply(envelope(turn, "need_context", { requests: [request(), request()] }), turn)).toThrow();
      return envelope(turn, "analysis_result", { result: { text: "valid" } });
    } }));
  });
  it.each([false, true])("deduplicates repeated selectors and stops no-progress loops (reuse ID=%s)", async reuse => {
    let resolved = 0;
    await expect(runAgentSession(options({ invoke: async turn => envelope(turn, "need_context", { requests: [request(reuse ? "r1" : `r${turn.round}`)] }),
      resolve: async item => { resolved++; return { requestId: item.requestId, status: "provided", evidenceIds: ["F1"] }; } }))).rejects.toMatchObject({ code: "AGENT_NO_PROGRESS" });
    expect(resolved).toBe(1);
  });
  it("rejects a reused ID that changes its selector", async () => {
    await expect(runAgentSession(options({ invoke: async turn => envelope(turn, "need_context", { requests: [request("r1", { id: `TASK_${turn.round}` })] }) })))
      .rejects.toMatchObject({ code: "AGENT_REQUEST_ID" });
  });
  it("enforces total rounds and per-round/total requests", async () => {
    await expect(runAgentSession(options({ limits: { maxRounds: 1 }, invoke: async turn => envelope(turn, "need_context", { requests: [request()] }) })))
      .rejects.toMatchObject({ code: "AGENT_ROUND_LIMIT" });
    await expect(runAgentSession(options({ limits: { maxRequestsPerRound: 1 }, invoke: async turn => envelope(turn, "need_context", { requests: [request(), request("r2")] }) })))
      .rejects.toMatchObject({ code: "AGENT_REQUEST_LIMIT" });
    await expect(runAgentSession(options({ limits: { maxRequests: 1 }, invoke: async turn => envelope(turn, "need_context", { requests: [request(`r${turn.round}`, { id: `TASK_${turn.round}` })] }) })))
      .rejects.toMatchObject({ code: "AGENT_REQUEST_LIMIT" });
  });
  it("bounds model input/output and returns oversized data as denied", async () => {
    let invoked = false;
    await expect(runAgentSession(options({ limits: { maxInputBytes: 1 }, invoke: async () => { invoked = true; return null; } }))).rejects.toMatchObject({ code: "AGENT_INPUT_LIMIT" });
    expect(invoked).toBe(false);
    await expect(runAgentSession(options({ limits: { maxResponseBytes: 1 } }))).rejects.toMatchObject({ code: "AGENT_RESPONSE_LIMIT" });
    const result = await runAgentSession(options({ limits: { maxDataBytes: 10 }, invoke: async turn => {
      if (turn.round === 1) return envelope(turn, "need_context", { requests: [request()] });
      expect(turn.responses[0]?.status).toBe("denied");
      return envelope(turn, "analysis_result", { result: { text: "partial evidence acknowledged" } });
    } }));
    expect(result.state.exchanges[0]?.response.status).toBe("denied");
  });
  it("resumes a partially resolved reply without repeating completed host lookups", async () => {
    const store = new InMemoryAgentSessionStore();
    const calls: string[] = []; let failSecond = true; let modelCalls = 0;
    const configuration = options({ store, invoke: async turn => { modelCalls++;
      return turn.round === 1 ? envelope(turn, "need_context", { requests: [request(), request("r2", { id: "TASK_B" })] }) : envelope(turn, "analysis_result", { result: { text: "resumed" } });
    }, resolve: async item => { calls.push(item.requestId); if (item.requestId === "r2" && failSecond) throw new Error("connection interrupted");
      return { requestId: item.requestId, status: "provided", evidenceIds: [item.requestId] }; } });
    await expect(runAgentSession(configuration)).rejects.toThrow("interrupted");
    failSecond = false;
    expect((await runAgentSession(configuration)).result).toBe("resumed");
    expect(calls).toEqual(["r1", "r2", "r2"]);
    expect(modelCalls).toBe(2);
    await runAgentSession(configuration);
    expect(modelCalls).toBe(2);
    await expect(runAgentSession({ ...configuration, seed: { sourceHash: "changed" } })).rejects.toMatchObject({ code: "AGENT_RESUME_SCOPE" });
  });
  it("propagates cancellation and explicit inability to complete", async () => {
    const controller = new AbortController(); controller.abort(new Error("cancelled"));
    await expect(runAgentSession(options({ signal: controller.signal }))).rejects.toThrow("cancelled");
    await expect(runAgentSession(options({ invoke: async turn => envelope(turn, "cannot_complete", { reason: "Required evidence is unavailable." }) })))
      .rejects.toMatchObject({ code: "AGENT_INCOMPLETE" });
  });
  it("persists checksummed checkpoints and refuses concurrent owners", async () => {
    const directory = await mkdtemp(join(tmpdir(), "atk-agent-test-")); directories.push(directory);
    const store = new FileAgentSessionStore(directory);
    await runAgentSession(options({ store }));
    expect((await store.load("test-session"))?.status).toBe("complete");
    await store.withLock("test-session", async () => {
      await expect(store.withLock("test-session", async () => null)).rejects.toMatchObject({ code: "EEXIST" });
    });
    const file = join(directory, "test-session.json");
    const checkpoint = JSON.parse(await readFile(file, "utf8")); checkpoint.state.result = { text: "tampered" };
    await writeFile(file, JSON.stringify(checkpoint));
    await expect(store.load("test-session")).rejects.toThrow("checksum");
  });
});

describe("memory execution scope", () => {
  it("filters before ranking and does not merge, summarize or compress different runs", async () => {
    const engine = new InMemoryMemoryEngine();
    for (const runId of ["run-A", "run-B"]) await engine.afterStep({ workflowId: "shared-workflow", runId, taskName: "analysis", currentStep: "analysis",
      taskType: "workflow", phase: "EXECUTION", input: new Map(), now: Date.now(), result: { status: "success" } });
    const result = await engine.beforeStep({ workflowId: "shared-workflow", runId: "run-B", taskName: "analysis", currentStep: "analysis",
      taskType: "workflow", phase: "EXECUTION", input: new Map(), now: Date.now() });
    expect(result.hits.length).toBeGreaterThan(0);
    expect(result.hits.every(hit => hit.record.runId === "run-B")).toBe(true);
    const summaries = await engine.list({ shard: "workflow", workflowId: "shared-workflow" });
    expect(new Set(summaries.map(item => item.runId))).toEqual(new Set(["run-A", "run-B"]));
    const first = summaries[0]!;
    await expect(engine.write({ ...first, runId: "run-C" })).rejects.toThrow("another execution scope");
  });
});
