import type { CycleOptions, MemoryRecordInput, RunOptions, WorkflowContext } from "../types.js";

function toRagMemoryRecord(
  workflowId: string,
  runId: string,
  now: number,
  document: { id?: string; text: string; meta?: Record<string, unknown> },
  index: number,
): MemoryRecordInput {
  return {
    id: `memory.knowledge.raw.rag.${workflowId}.${document.id ?? index}`,
    shard: "knowledge",
    kind: "raw",
    payload: {
      id: document.id ?? `rag-${index}`,
      content: document.text,
      embedding: [],
      tags: (document.meta?.keywords as string[] | undefined) ?? ["rag", "input"],
    },
    description: "RAG document injected at run time",
    keywords: ["rag", "input", ...((document.meta?.keywords as string[] | undefined) ?? [])],
    importance: 0.85,
    workflowId,
    runId,
    phase: "PLANNING",
    taskType: "default",
    sourceTask: "run.bootstrap",
  };
}

export async function injectRag(
  workflowId: string,
  runId: string,
  memory: NonNullable<CycleOptions["memoryEngine"]> | WorkflowContext["memory"],
  now: number,
  rag: RunOptions["rag"],
): Promise<void> {
  if (!rag) {
    return;
  }

  for (const [index, document] of rag.entries()) {
    await memory.write(toRagMemoryRecord(workflowId, runId, now, document, index));
  }
}

export async function injectMemory(
  memory: NonNullable<CycleOptions["memoryEngine"]> | WorkflowContext["memory"],
  pieces: RunOptions["memoryInjection"],
): Promise<void> {
  if (!pieces) {
    return;
  }

  for (const piece of pieces) {
    await memory.write(piece);
  }
}
