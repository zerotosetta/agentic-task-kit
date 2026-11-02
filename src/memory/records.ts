import type {
  AfterStepInput,
  EmbeddingProvider,
  GraphStore,
  KnowledgeMemory,
  MemoryRecord,
  MemoryRecordFilter,
  MemoryRecordInput,
  MemoryStats,
  TaskMemory,
  WorkflowMemory,
} from "../types.js";
import { stringifyPayload, uniqueStrings } from "./text.js";

export function matchesRecordFilter(record: MemoryRecord, filter: MemoryRecordFilter): boolean {
  if (filter.shard && record.shard !== filter.shard) {
    return false;
  }

  if (filter.kind && record.kind !== filter.kind) {
    return false;
  }

  if (filter.archived === true && !record.archivedAt) {
    return false;
  }

  if (filter.archived === false && record.archivedAt) {
    return false;
  }

  if (filter.workflowId && record.workflowId !== filter.workflowId) {
    return false;
  }

  if (filter.runId && record.runId !== filter.runId) {
    return false;
  }

  if (filter.sourceTask && record.sourceTask !== filter.sourceTask) {
    return false;
  }

  return true;
}

export function createShardStats(): MemoryStats["byShard"] {
  return {
    user: { total: 0, active: 0, archived: 0, raw: 0, summary: 0 },
    task: { total: 0, active: 0, archived: 0, raw: 0, summary: 0 },
    workflow: { total: 0, active: 0, archived: 0, raw: 0, summary: 0 },
    system: { total: 0, active: 0, archived: 0, raw: 0, summary: 0 },
    knowledge: { total: 0, active: 0, archived: 0, raw: 0, summary: 0 },
  };
}

export function createKindStats(): MemoryStats["byKind"] {
  return {
    raw: { total: 0, active: 0, archived: 0 },
    summary: { total: 0, active: 0, archived: 0 },
  };
}

export function mergeRecords(
  current: MemoryRecord,
  next: MemoryRecordInput,
  now: number,
  importance: number,
): MemoryRecord {
  return {
    ...current,
    payload: mergePayload(current.payload, next.payload),
    description: next.description,
    keywords: uniqueStrings([...current.keywords, ...(next.keywords ?? [])]),
    importance: Math.max(current.importance, importance),
    updatedAt: now,
    lastAccessedAt: now,
    ...(next.phase ? { phase: next.phase } : {}),
    ...(next.taskType ? { taskType: next.taskType } : {}),
    supersedes: uniqueStrings([...(current.supersedes ?? []), current.id]),
  };
}

function mergePayload(current: MemoryRecord["payload"], next: MemoryRecordInput["payload"]) {
  if (isWorkflowMemory(current) && isWorkflowMemory(next)) {
    return {
      ...current,
      currentStep: next.currentStep,
      history: [...current.history, ...next.history],
      contextSummary: next.contextSummary,
    } satisfies WorkflowMemory;
  }

  if (isTaskMemory(current) && isTaskMemory(next)) {
    return {
      ...current,
      status: next.status,
      input: next.input,
      output: next.output,
      errors: uniqueStrings([...current.errors, ...next.errors]),
      updatedAt: next.updatedAt,
    } satisfies TaskMemory;
  }

  return next;
}

export async function resolveRecordEmbedding(
  input: MemoryRecordInput,
  provider: EmbeddingProvider,
): Promise<{ payload: MemoryRecord["payload"]; embedding: number[]; embeddingModelId: string }> {
  let payload = input.payload;
  const knowledge = input.shard === "knowledge" ? (payload as KnowledgeMemory) : undefined;
  let embedding =
    input.embedding ??
    (Array.isArray(knowledge?.embedding) && knowledge.embedding.length
      ? knowledge.embedding
      : undefined);
  let modelId = input.embeddingModelId;
  if (!embedding) {
    const result = await provider.embed(
      knowledge ? knowledge.content : stringifyPayload(payload, input.description),
    );
    embedding = result.embedding;
    modelId ??= result.modelId;
  }
  if (!modelId) modelId = (await provider.embed(input.description)).modelId;
  if (knowledge) payload = { ...knowledge, embedding };
  return { payload, embedding, embeddingModelId: modelId };
}

export function buildTaskPayload(input: AfterStepInput): TaskMemory {
  return {
    taskId: `${input.workflowId}.${input.taskName}`,
    status:
      input.result.status === "fail"
        ? "failed"
        : input.result.status === "success"
          ? "done"
          : "running",
    input: input.input,
    output: input.result.output ?? null,
    errors: input.result.error?.message ? [input.result.error.message] : [],
    updatedAt: input.now,
  };
}

export function summarizeWorkflowStep(input: AfterStepInput): string {
  if (input.result.error?.message) {
    return `${input.taskName} failed: ${input.result.error.message}`;
  }

  return `${input.taskName} ${input.result.status}`;
}

export async function linkSupersedes(
  graphStore: GraphStore,
  from: string,
  to: string,
  relation: "supersedes" | "merged-into",
): Promise<void> {
  if (from === to) {
    return;
  }

  await graphStore.addEdge({
    from,
    to,
    relation,
  });
}

export function isTaskMemory(payload: MemoryRecord["payload"]): payload is TaskMemory {
  return "taskId" in payload;
}

function isWorkflowMemory(payload: MemoryRecord["payload"]): payload is WorkflowMemory {
  return "contextSummary" in payload && "history" in payload;
}
