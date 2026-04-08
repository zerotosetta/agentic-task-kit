import { describe, expect, it } from "vitest";

import {
  createObservedMemoryEngine,
  createWorkflowInput,
  DeterministicHashEmbeddingProvider,
  ExecutionBroadcaster,
  InMemoryKVStore,
  InMemoryMemoryEngine,
  InMemoryVectorStore,
  type ExecutionEvent,
  type KnowledgeMemory,
  type MemoryRecord,
  type UserMemory,
  type WorkflowMemory,
} from "../src/index.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const LARGE_CONTEXT_BLOCK = "repeated-memory-block ".repeat(40_000);

describe("Memory Engine V2", () => {
  it("routes retrieval by fixed shard rules and respects context assembly", async () => {
    const engine = new InMemoryMemoryEngine();

    await engine.write({
      id: "memory.user.summary.demo-user",
      shard: "user",
      kind: "summary",
      payload: {
        userId: "demo-user",
        preferences: ["preserve behavior"],
        behaviorPatterns: ["checks summary before rollout"],
        lastUpdated: Date.now(),
      } satisfies UserMemory,
      description: "User preference summary",
      keywords: ["user", "preference", "behavior"],
      importance: 0.9,
      phase: "PLANNING",
      taskType: "user",
    });
    await engine.write({
      id: "memory.workflow.summary.demo-report",
      shard: "workflow",
      kind: "summary",
      payload: {
        workflowId: "wf-demo",
        currentStep: "planning",
        history: [],
        contextSummary: "Workflow summary for planning stage",
      } satisfies WorkflowMemory,
      description: "Workflow summary",
      keywords: ["workflow", "summary", "planning"],
      importance: 0.9,
      phase: "PLANNING",
      taskType: "workflow",
    });
    await engine.write({
      id: "memory.knowledge.raw.demo-runbook",
      shard: "knowledge",
      kind: "raw",
      payload: {
        id: "demo-runbook",
        content: "Knowledge runbook for validation troubleshooting",
        embedding: [],
        tags: ["knowledge", "runbook", "validation"],
      } satisfies KnowledgeMemory,
      description: "Knowledge runbook",
      keywords: ["knowledge", "runbook", "validation"],
      importance: 0.9,
      phase: "PLANNING",
      taskType: "default",
    });

    const userResult = await engine.retrieve({
      query: "user preference behavior",
      taskType: "user",
      phase: "PLANNING",
    });
    expect(userResult.routedShards).toEqual(["user"]);
    expect(userResult.hits.map((hit) => hit.record.shard)).toEqual(["user"]);

    const workflowResult = await engine.retrieve({
      query: "workflow planning summary",
      taskType: "workflow",
      phase: "EXECUTION",
    });
    expect(workflowResult.routedShards).toEqual(["workflow", "task"]);
    expect(workflowResult.hits.some((hit) => hit.record.shard === "knowledge")).toBe(false);
    expect(workflowResult.assembledContext).toContain("[workflow/summary] Workflow summary");
  });

  it("overwrites similar records by default, supports configurable actions, and emits warning events", async () => {
    const observedEvents: ExecutionEvent[] = [];
    const observedEngine = createObservedMemoryEngine({
      engine: new InMemoryMemoryEngine(),
      broadcaster: new ExecutionBroadcaster([
        {
          onEvent(event) {
            observedEvents.push(event);
          },
        },
      ]),
      workflowId: "wf-similar",
      runId: "run-similar",
      now: () => Date.now(),
    });

    const first = await observedEngine.write({
      shard: "workflow",
      kind: "raw",
      payload: {
        workflowId: "wf-similar",
        currentStep: "collect-1",
        history: [],
        contextSummary: LARGE_CONTEXT_BLOCK,
      } satisfies WorkflowMemory,
      description: "Repeated workflow memory block for overwrite regression",
      keywords: ["memory", "workflow", "issue-15"],
      workflowId: "wf-similar",
      runId: "run-similar",
      sourceTask: "regression",
      phase: "EXECUTION",
      taskType: "workflow",
    });
    const second = await observedEngine.write({
      shard: "workflow",
      kind: "raw",
      payload: {
        workflowId: "wf-similar",
        currentStep: "collect-2",
        history: [],
        contextSummary: LARGE_CONTEXT_BLOCK,
      } satisfies WorkflowMemory,
      description: "Repeated workflow memory block for overwrite regression",
      keywords: ["memory", "workflow", "issue-15"],
      workflowId: "wf-similar",
      runId: "run-similar",
      sourceTask: "regression",
      phase: "EXECUTION",
      taskType: "workflow",
    });

    expect(first.action).toBe("create");
    expect(second.action).toBe("overwrite");
    expect(second.recordId).toBe(first.recordId);
    expect(second.warningCode).toBe("similar_overwrite");
    expect(
      observedEvents.some(
        (event) => event.type === "memory.warning" && event.meta?.code === "similar_overwrite",
      ),
    ).toBe(true);

    const visibleRecords = await observedEngine.list({
      shard: "workflow",
      kind: "raw",
      archived: false,
    });
    expect(
      visibleRecords.filter((record) => record.workflowId === "wf-similar").map((record) => record.id),
    ).toEqual([first.recordId]);

    const mergeEngine = new InMemoryMemoryEngine({
      writePolicy: {
        similarWriteAction: "merge",
      },
    });
    await mergeEngine.write({
      shard: "workflow",
      kind: "raw",
      payload: {
        workflowId: "wf-merge",
        currentStep: "collect-1",
        history: [],
        contextSummary: LARGE_CONTEXT_BLOCK,
      } satisfies WorkflowMemory,
      description: "Repeated workflow memory block for merge regression",
      keywords: ["memory", "workflow", "issue-15"],
      workflowId: "wf-merge",
      runId: "run-merge",
      sourceTask: "regression",
      phase: "EXECUTION",
      taskType: "workflow",
    });
    const merged = await mergeEngine.write({
      shard: "workflow",
      kind: "raw",
      payload: {
        workflowId: "wf-merge",
        currentStep: "collect-2",
        history: [],
        contextSummary: LARGE_CONTEXT_BLOCK,
      } satisfies WorkflowMemory,
      description: "Repeated workflow memory block for merge regression",
      keywords: ["memory", "workflow", "issue-15"],
      workflowId: "wf-merge",
      runId: "run-merge",
      sourceTask: "regression",
      phase: "EXECUTION",
      taskType: "workflow",
    });
    expect(merged.action).toBe("merge");
    expect(merged.warningCode).toBe("similar_merge");

    const discardEngine = new InMemoryMemoryEngine();
    const created = await discardEngine.write({
      shard: "workflow",
      kind: "raw",
      payload: {
        workflowId: "wf-discard",
        currentStep: "collect-1",
        history: [],
        contextSummary: LARGE_CONTEXT_BLOCK,
      } satisfies WorkflowMemory,
      description: "Repeated workflow memory block for discard regression",
      keywords: ["memory", "workflow", "issue-15"],
      workflowId: "wf-discard",
      runId: "run-discard",
      sourceTask: "regression",
      phase: "EXECUTION",
      taskType: "workflow",
    });
    const discardedSimilar = await discardEngine.write({
      shard: "workflow",
      kind: "raw",
      payload: {
        workflowId: "wf-discard",
        currentStep: "collect-2",
        history: [],
        contextSummary: LARGE_CONTEXT_BLOCK,
      } satisfies WorkflowMemory,
      description: "Repeated workflow memory block for discard regression",
      keywords: ["memory", "workflow", "issue-15"],
      workflowId: "wf-discard",
      runId: "run-discard",
      sourceTask: "regression",
      phase: "EXECUTION",
      taskType: "workflow",
      similarWriteAction: "discard",
    });
    expect(created.action).toBe("create");
    expect(discardedSimilar.action).toBe("discard");
    expect(discardedSimilar.targetId).toBe(created.recordId);
    expect(discardedSimilar.warningCode).toBe("similar_discard");
  });

  it("discards low-importance writes, compresses repeated task events, and archives stale records", async () => {
    const kvStore = new InMemoryKVStore();
    const vectorStore = new InMemoryVectorStore();
    const embeddingProvider = new DeterministicHashEmbeddingProvider();
    const engine = new InMemoryMemoryEngine({
      kvStore,
      vectorStore,
      embeddingProvider,
    });

    const discarded = await engine.write({
      shard: "task",
      kind: "raw",
      payload: {
        taskId: "discarded-task",
        status: "failed",
        input: null,
        output: null,
        errors: ["noop"],
        updatedAt: Date.now(),
      },
      description: "Discard me",
      keywords: ["discard"],
      importance: 0.2,
    });
    expect(discarded.action).toBe("discard");
    expect(discarded.warningCode).toBe("low_importance_discard");

    const staleEmbedding = await embeddingProvider.embed("stale knowledge");
    const staleRecord: MemoryRecord = {
      id: "memory.knowledge.raw.stale",
      shard: "knowledge",
      kind: "raw",
      payload: {
        id: "stale",
        content: "stale knowledge",
        embedding: staleEmbedding.embedding,
        tags: ["stale"],
      } satisfies KnowledgeMemory,
      description: "Stale knowledge record",
      keywords: ["knowledge", "stale"],
      importance: 0.8,
      createdAt: Date.now() - 45 * DAY_MS,
      updatedAt: Date.now() - 45 * DAY_MS,
      lastAccessedAt: Date.now() - 45 * DAY_MS,
      embedding: staleEmbedding.embedding,
      embeddingModelId: staleEmbedding.modelId,
      phase: "PLANNING",
      taskType: "default",
    };
    await kvStore.put(staleRecord);
    await vectorStore.upsert({
      id: staleRecord.id,
      embedding: staleEmbedding.embedding,
    });

    for (let index = 0; index < 3; index += 1) {
      await engine.afterStep({
        workflowId: "wf-repeat",
        runId: "run-repeat",
        currentStep: "validate",
        taskName: "validate",
        taskType: "debug",
        phase: "RECOVERY",
        input: createWorkflowInput({
          index,
        }),
        result: {
          status: "fail",
          error: {
            message: "LEGACY_VALIDATION_FAILED",
          },
        },
        now: Date.now() + index,
      });
    }

    const compressed = await engine.list({
      shard: "task",
      kind: "summary",
      archived: false,
    });
    expect(
      compressed.some((record) =>
        record.description.startsWith("Compressed repeated task events:"),
      ),
    ).toBe(true);

    const lifecycle = await engine.runLifecycle(Date.now());
    expect(lifecycle.archivedIds).toContain("memory.knowledge.raw.stale");
    expect(lifecycle.expiredIds).toContain("memory.knowledge.raw.stale");
  });
});
