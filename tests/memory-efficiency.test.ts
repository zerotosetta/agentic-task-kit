import { describe, expect, it, vi } from "vitest";
import { InMemoryMemoryEngine, type KnowledgeMemory, type WorkflowMemory } from "../src/index.js";

describe("Memory embedding efficiency", () => {
  it.each(["workflow", "knowledge"] as const)(
    "embeds a new %s record once and reuses its model metadata",
    async (shard) => {
      const embed = vi.fn(async () => ({ embedding: [0.4, 0.6], modelId: "counting" }));
      const engine = new InMemoryMemoryEngine({ embeddingProvider: { embed } });
      const payload =
        shard === "knowledge"
          ? ({ id: "kb", content: "content", embedding: [], tags: [] } satisfies KnowledgeMemory)
          : ({
              workflowId: "wf",
              currentStep: "step",
              history: [],
              contextSummary: "summary",
            } satisfies WorkflowMemory);
      const write = await engine.write({
        shard,
        kind: "raw",
        payload,
        description: "description",
        importance: 0.9,
      });
      expect(embed).toHaveBeenCalledOnce();
      const record = (await engine.list()).find((record) => record.id === write.recordId);
      expect(record).toMatchObject({ embedding: [0.4, 0.6], embeddingModelId: "counting" });
      if (shard === "knowledge")
        expect(record?.payload).toMatchObject({ embedding: record?.embedding });
    },
  );
  it("uses an injected embedding and model without an extra provider call", async () => {
    const embed = vi.fn(async () => ({ embedding: [1], modelId: "unused" }));
    const engine = new InMemoryMemoryEngine({ embeddingProvider: { embed } });
    await engine.write({
      shard: "knowledge",
      kind: "raw",
      payload: { id: "kb", content: "content", embedding: [], tags: [] },
      description: "description",
      importance: 0.9,
      embedding: [0.7],
      embeddingModelId: "injected",
    });
    expect(embed).not.toHaveBeenCalled();
    expect((await engine.list())[0]).toMatchObject({
      embedding: [0.7],
      embeddingModelId: "injected",
      payload: { embedding: [0.7] },
    });
  });
});
