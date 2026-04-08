import { createHash, randomUUID } from "node:crypto";

import { ExecutionBroadcaster } from "./events.js";
import type {
  AfterStepInput,
  BeforeStepInput,
  EmbeddingProvider,
  ExecutionEvent,
  GraphStore,
  KVStore,
  KnowledgeMemory,
  MemoryFlushReport,
  LifecycleReport,
  MemoryEngine,
  MemoryKind,
  MemoryPhase,
  MemoryRecord,
  MemoryRecordFilter,
  MemoryRecordInput,
  MemoryShard,
  MemorySimilarWriteAction,
  MemoryStats,
  MemoryTaskType,
  MemoryWritePolicy,
  MemoryWriteReport,
  RetrieveHit,
  RetrieveRequest,
  RetrieveResult,
  StepExecutionLog,
  StepMemoryContext,
  TaskMemory,
  TaskResult,
  VectorStore,
  WorkflowMemory,
  WriteDisposition
} from "./types.js";
import { toSerializableValue } from "./workflow-input.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_CONTEXT_TOKENS = 8_192;
const DEFAULT_SIMILARITY_THRESHOLD = 0.85;
const DEFAULT_SIMILAR_WRITE_ACTION: MemorySimilarWriteAction = "overwrite";
const REPEATED_EVENT_THRESHOLD = 3;

type MemoryEventType =
  | "memory.before_step"
  | "memory.after_step"
  | "memory.write"
  | "memory.warning"
  | "memory.merge"
  | "memory.compress"
  | "memory.expire"
  | "memory.archive"
  | "retrieval.performed";

export class DeterministicHashEmbeddingProvider implements EmbeddingProvider {
  constructor(
    private readonly dimensions = 16,
    private readonly modelId = "deterministic-hash-embedder",
  ) {}

  async embed(text: string): Promise<{ embedding: number[]; modelId: string }> {
    const normalized = normalizeQuery(text);
    const digest = createHash("sha256").update(normalized, "utf8").digest();
    const embedding = Array.from({ length: this.dimensions }, (_, index) => {
      const byte = digest[index % digest.length] ?? 0;
      return byte / 255;
    });

    return {
      embedding,
      modelId: this.modelId
    };
  }
}

export class InMemoryKVStore implements KVStore {
  private readonly active = new Map<string, MemoryRecord>();
  private readonly archived = new Map<string, MemoryRecord>();

  async put(record: MemoryRecord): Promise<void> {
    const target = record.archivedAt ? this.archived : this.active;
    const opposite = record.archivedAt ? this.active : this.archived;
    opposite.delete(record.id);
    target.set(record.id, { ...record });
  }

  async get(id: string): Promise<MemoryRecord | null> {
    return this.active.get(id) ?? this.archived.get(id) ?? null;
  }

  async delete(id: string): Promise<void> {
    this.active.delete(id);
    this.archived.delete(id);
  }

  async archive(id: string, archivedAt: number): Promise<MemoryRecord | null> {
    const current = this.active.get(id);
    if (!current) {
      return null;
    }

    this.active.delete(id);
    const archived = {
      ...current,
      archivedAt
    };
    this.archived.set(id, archived);
    return archived;
  }

  async list(args?: {
    shard?: MemoryShard;
    kind?: MemoryKind;
    archived?: boolean;
  }): Promise<MemoryRecord[]> {
    const source =
      args?.archived === true
        ? this.archived.values()
        : args?.archived === false
          ? this.active.values()
          : [...this.active.values(), ...this.archived.values()];

    return [...source].filter((record) => {
      if (args?.shard && record.shard !== args.shard) {
        return false;
      }

      if (args?.kind && record.kind !== args.kind) {
        return false;
      }

      return true;
    });
  }
}

export class InMemoryVectorStore implements VectorStore {
  private readonly active = new Map<string, number[]>();
  private readonly archived = new Map<string, number[]>();

  async upsert(args: { id: string; embedding: number[]; archived?: boolean }): Promise<void> {
    const target = args.archived ? this.archived : this.active;
    const opposite = args.archived ? this.active : this.archived;
    opposite.delete(args.id);
    target.set(args.id, [...args.embedding]);
  }

  async delete(id: string, archived = false): Promise<void> {
    const target = archived ? this.archived : this.active;
    target.delete(id);
  }

  async search(args: {
    embedding: number[];
    topK: number;
    ids?: string[];
    archived?: boolean;
  }): Promise<Array<{ id: string; score: number }>> {
    const source = args.archived ? this.archived : this.active;
    const allowed = args.ids ? new Set(args.ids) : undefined;

    return [...source.entries()]
      .filter(([id]) => (allowed ? allowed.has(id) : true))
      .map(([id, embedding]) => ({
        id,
        score: cosineSimilarity(args.embedding, embedding)
      }))
      .sort((left, right) => right.score - left.score)
      .slice(0, args.topK);
  }
}

export class InMemoryGraphStore implements GraphStore {
  private readonly edges = new Map<
    string,
    Array<{
      from: string;
      to: string;
      relation: string;
      meta?: Record<string, unknown>;
    }>
  >();

  async addEdge(args: {
    from: string;
    to: string;
    relation: "supersedes" | "merged-into" | "compressed-into" | "archived-from" | "workflow-step";
    meta?: Record<string, unknown>;
  }): Promise<void> {
    const forward = this.edges.get(args.from) ?? [];
    forward.push({
      from: args.from,
      to: args.to,
      relation: args.relation,
      ...(args.meta ? { meta: args.meta } : {})
    });
    this.edges.set(args.from, forward);
  }

  async listEdges(id: string): Promise<
    Array<{
      from: string;
      to: string;
      relation: string;
      meta?: Record<string, unknown>;
    }>
  > {
    return this.edges.get(id) ?? [];
  }

  async delete(id: string): Promise<void> {
    this.edges.delete(id);
    for (const [key, value] of this.edges.entries()) {
      const next = value.filter((edge) => edge.from !== id && edge.to !== id);
      if (next.length === 0) {
        this.edges.delete(key);
        continue;
      }
      this.edges.set(key, next);
    }
  }
}

type MemoryEngineOptions = {
  kvStore?: KVStore;
  vectorStore?: VectorStore;
  graphStore?: GraphStore;
  embeddingProvider?: EmbeddingProvider;
  maxContextTokens?: number;
  writePolicy?: MemoryWritePolicy;
};

export class InMemoryMemoryEngine implements MemoryEngine {
  private readonly kvStore: KVStore;
  private readonly vectorStore: VectorStore;
  private readonly graphStore: GraphStore;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly maxContextTokens: number;
  private readonly writePolicy: Required<MemoryWritePolicy>;

  constructor(options: MemoryEngineOptions = {}) {
    this.kvStore = options.kvStore ?? new InMemoryKVStore();
    this.vectorStore = options.vectorStore ?? new InMemoryVectorStore();
    this.graphStore = options.graphStore ?? new InMemoryGraphStore();
    this.embeddingProvider =
      options.embeddingProvider ?? new DeterministicHashEmbeddingProvider();
    this.maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    this.writePolicy = {
      similarWriteAction:
        options.writePolicy?.similarWriteAction ?? DEFAULT_SIMILAR_WRITE_ACTION,
      similarityThreshold:
        options.writePolicy?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD
    };
  }

  async beforeStep(input: BeforeStepInput): Promise<StepMemoryContext> {
    const query = buildStepQuery(input);
    const retrieveResult = await this.retrieve({
      query,
      taskType: input.taskType,
      phase: input.phase
    });

    return {
      ...retrieveResult,
      currentStep: input.currentStep,
      taskName: input.taskName,
      phase: input.phase,
      taskType: input.taskType
    };
  }

  async afterStep(input: AfterStepInput): Promise<MemoryWriteReport> {
    const taskRecord = await this.write({
      id: `memory.task.raw.${input.workflowId}.${input.taskName}.${input.runId}.${input.now}`,
      shard: "task",
      kind: "raw",
      payload: buildTaskPayload(input),
      description: `Task execution state for ${input.taskName}`,
      keywords: [
        "task",
        input.taskName,
        input.result.status,
        input.taskType.toLowerCase()
      ],
      workflowId: input.workflowId,
      runId: input.runId,
      sourceTask: input.taskName,
      phase: input.phase,
      taskType: input.taskType
    });

    const workflowSummary = await this.buildWorkflowSummaryRecord(input);
    const workflowRecord = await this.write(workflowSummary);
    const compressedIds = await this.compressRepeatedEvents(input.workflowId);

    return {
      taskRecord,
      workflowRecord,
      compressedIds,
      discardedIds: [
        taskRecord.action === "discard" && taskRecord.recordId ? taskRecord.recordId : undefined,
        workflowRecord.action === "discard" && workflowRecord.recordId ? workflowRecord.recordId : undefined
      ].filter((value): value is string => typeof value === "string")
    };
  }

  async write(record: MemoryRecordInput): Promise<WriteDisposition> {
    const now = Date.now();
    const existing = record.id ? await this.kvStore.get(record.id) : null;
    const candidates = await this.kvStore.list({
      shard: record.shard,
      kind: record.kind,
      archived: false
    });
    const normalizedContent = stringifyPayload(record.payload, record.description);
    const similarityMatch = findSimilarityMatch(record, candidates, normalizedContent);
    const similarWriteAction =
      record.similarWriteAction ?? this.writePolicy.similarWriteAction;
    const canApplySimilarityPolicy =
      similarityMatch !== null &&
      similarityMatch.score >= this.writePolicy.similarityThreshold &&
      !(record.shard === "task" && record.kind === "raw");
    const novelty =
      canApplySimilarityPolicy && similarityMatch
        ? Math.max(0, 1 - similarityMatch.score)
        : 1;
    const importance = clamp01(
      record.importance ?? calculateImportance(record, novelty),
    );

    if (existing) {
      const next = await this.materializeRecord(record, now, importance, existing.createdAt);
      await this.persistRecord(next);
      await linkSupersedes(this.graphStore, existing.id, next.id, "supersedes");
      return {
        action: "overwrite",
        recordId: next.id,
        reason: "existing id overwritten",
        importance
      };
    }

    if (canApplySimilarityPolicy && similarityMatch) {
      if (similarWriteAction === "discard") {
        return {
          action: "discard",
          targetId: similarityMatch.record.id,
          reason: `similar record discarded at score ${similarityMatch.score.toFixed(2)} by policy`,
          importance,
          similarityScore: similarityMatch.score,
          warningCode: "similar_discard"
        };
      }

      if (similarWriteAction === "merge") {
        const merged = mergeRecords(similarityMatch.record, record, now, importance);
        await this.persistRecord(merged);
        await linkSupersedes(this.graphStore, similarityMatch.record.id, merged.id, "merged-into");
        return {
          action: "merge",
          recordId: merged.id,
          targetId: similarityMatch.record.id,
          reason: `similar record merged at score ${similarityMatch.score.toFixed(2)}`,
          importance,
          similarityScore: similarityMatch.score,
          warningCode: "similar_merge"
        };
      }

      const overwritten = await this.materializeRecord(
        {
          ...record,
          id: similarityMatch.record.id,
          supersedes: uniqueStrings([
            ...(similarityMatch.record.supersedes ?? []),
            ...(record.supersedes ?? [])
          ])
        },
        now,
        Math.max(similarityMatch.record.importance, importance),
        similarityMatch.record.createdAt,
      );
      await this.persistRecord(overwritten);
      return {
        action: "overwrite",
        recordId: overwritten.id,
        targetId: similarityMatch.record.id,
        reason: `similar record overwritten at score ${similarityMatch.score.toFixed(2)}`,
        importance: overwritten.importance,
        similarityScore: similarityMatch.score,
        warningCode: "similar_overwrite"
      };
    }

    if (importance < 0.6) {
      return {
        action: "discard",
        reason: `importance ${importance.toFixed(2)} is below 0.6`,
        importance,
        warningCode: "low_importance_discard"
      };
    }

    const created = await this.materializeRecord(record, now, importance, now);
    await this.persistRecord(created);
    return {
      action: "create",
      recordId: created.id,
      reason: "record created",
      importance
    };
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const record = await this.kvStore.get(id);
    if (!record) {
      return null;
    }

    const touched = {
      ...record,
      lastAccessedAt: Date.now()
    };
    await this.kvStore.put(touched);
    return touched;
  }

  async retrieve(request: RetrieveRequest): Promise<RetrieveResult> {
    const normalizedQuery = normalizeQuery(request.query);
    const routedShards = routeMemory(request.taskType);
    const records = (
      await Promise.all(
        routedShards.map((shard) =>
          this.kvStore.list({
            shard,
            archived: false
          }),
        ),
      )
    ).flat();
    const queryEmbedding = await this.embeddingProvider.embed(normalizedQuery);
    const candidateIds = records.map((record) => record.id);
    const semanticHits = await this.vectorStore.search({
      embedding: queryEmbedding.embedding,
      topK: Math.max(candidateIds.length, request.topK ?? 5),
      ids: candidateIds,
      archived: false
    });
    const semanticMap = new Map(semanticHits.map((hit) => [hit.id, hit.score]));
    const topK = request.topK ?? 5;

    const hits = records
      .map((record) => {
        const keywordScore = computeKeywordScore(record, normalizedQuery);
        const semanticScore = semanticMap.get(record.id) ?? 0;
        const recencyScore = computeRecencyScore(record);
        const importanceScore = clamp01(record.importance);
        const finalScore =
          semanticScore * 0.4 +
          keywordScore * 0.2 +
          recencyScore * 0.2 +
          importanceScore * 0.2;

        return {
          record,
          semanticScore,
          keywordScore,
          recencyScore,
          importanceScore,
          finalScore
        } satisfies RetrieveHit;
      })
      .filter((hit) => hit.finalScore > 0)
      .sort((left, right) => right.finalScore - left.finalScore)
      .slice(0, topK);

    for (const hit of hits) {
      await this.kvStore.put({
        ...hit.record,
        lastAccessedAt: Date.now()
      });
    }

    const maxTokens = request.maxContextTokens ?? this.maxContextTokens;
    const { assembledContext, usedTokens } = assembleContext({
      hits,
      phase: request.phase,
      maxTokens
    });

    return {
      query: request.query,
      normalizedQuery,
      routedShards,
      hits,
      assembledContext,
      usedTokens,
      maxTokens
    };
  }

  async runLifecycle(now = Date.now()): Promise<LifecycleReport> {
    const archivedIds: string[] = [];
    const deletedIds: string[] = [];
    const expiredIds: string[] = [];
    const compressedIds = await this.compressRepeatedEvents();
    const active = await this.kvStore.list({
      archived: false
    });

    for (const record of active) {
      if (record.importance < 0.3) {
        await this.kvStore.delete(record.id);
        await this.vectorStore.delete(record.id, false);
        deletedIds.push(record.id);
        continue;
      }

      if (now - record.lastAccessedAt > 30 * DAY_MS) {
        const archived = await this.kvStore.archive(record.id, now);
        if (archived) {
          await this.vectorStore.delete(record.id, false);
          if (archived.embedding) {
            await this.vectorStore.upsert({
              id: archived.id,
              embedding: archived.embedding,
              archived: true
            });
          }
          await this.graphStore.addEdge({
            from: archived.id,
            to: archived.id,
            relation: "archived-from",
            meta: {
              archivedAt: now
            }
          });
          archivedIds.push(record.id);
          expiredIds.push(record.id);
        }
      }
    }

    return {
      archivedIds,
      deletedIds,
      compressedIds,
      expiredIds
    };
  }

  async getStats(filter: MemoryRecordFilter = {}): Promise<MemoryStats> {
    const active = await this.list({
      ...filter,
      archived: false
    });
    const archived = await this.list({
      ...filter,
      archived: true
    });
    const records = [...active, ...archived];

    const byShard = createShardStats();
    const byKind = createKindStats();

    for (const record of records) {
      const shardStats = byShard[record.shard];
      shardStats.total += 1;
      shardStats[record.kind] += 1;
      if (record.archivedAt) {
        shardStats.archived += 1;
      } else {
        shardStats.active += 1;
      }

      const kindStats = byKind[record.kind];
      kindStats.total += 1;
      if (record.archivedAt) {
        kindStats.archived += 1;
      } else {
        kindStats.active += 1;
      }
    }

    const heapUsage = process.memoryUsage();
    return {
      heap: {
        rss: heapUsage.rss,
        heapTotal: heapUsage.heapTotal,
        heapUsed: heapUsage.heapUsed,
        external: heapUsage.external,
        arrayBuffers: heapUsage.arrayBuffers
      },
      totalRecords: records.length,
      activeRecords: active.length,
      archivedRecords: archived.length,
      byShard,
      byKind
    };
  }

  async flush(filter: MemoryRecordFilter = {}): Promise<MemoryFlushReport> {
    const deleteArchived = filter.archived !== false;
    const deleteActive = filter.archived !== true;
    const deletedIds: string[] = [];
    const deletedArchivedIds: string[] = [];

    const purge = async (record: MemoryRecord, archived: boolean): Promise<void> => {
      await this.kvStore.delete(record.id);
      await this.vectorStore.delete(record.id, archived);
      await this.graphStore.delete(record.id);
      if (archived) {
        deletedArchivedIds.push(record.id);
      } else {
        deletedIds.push(record.id);
      }
    };

    if (deleteActive) {
      const activeRecords = await this.list({
        ...filter,
        archived: false
      });
      for (const record of activeRecords) {
        await purge(record, false);
      }
    }

    if (deleteArchived) {
      const archivedRecords = await this.list({
        ...filter,
        archived: true
      });
      for (const record of archivedRecords) {
        await purge(record, true);
      }
    }

    const remainingActive = (await this.kvStore.list({ archived: false })).length;
    const remainingArchived = (await this.kvStore.list({ archived: true })).length;

    return {
      deletedIds,
      deletedArchivedIds,
      remainingActive,
      remainingArchived,
      filters: { ...filter }
    };
  }

  async list(args: MemoryRecordFilter = {}): Promise<MemoryRecord[]> {
    const base = await this.kvStore.list({
      ...(args.shard ? { shard: args.shard } : {}),
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.archived !== undefined ? { archived: args.archived } : {})
    });

    return base.filter((record) => matchesRecordFilter(record, args));
  }

  private async buildWorkflowSummaryRecord(input: AfterStepInput): Promise<MemoryRecordInput> {
    const recordId = `memory.workflow.summary.${input.workflowId}`;
    const existing = await this.get(recordId);
    const payload = existing?.payload as WorkflowMemory | undefined;
    const summary = summarizeWorkflowStep(input);
    const nextHistory: StepExecutionLog[] = [
      ...(payload?.history ?? []),
      {
        stepName: input.taskName,
        status: input.result.status,
        startedAt: input.now,
        endedAt: input.now,
        summary,
        ...(input.result.error?.message ? { error: input.result.error.message } : {})
      }
    ];

    return {
      id: recordId,
      shard: "workflow",
      kind: "summary",
      payload: {
        workflowId: input.workflowId,
        currentStep: input.currentStep,
        history: nextHistory,
        contextSummary: nextHistory
          .slice(-5)
          .map((entry) => `${entry.stepName}:${entry.status}`)
          .join(", ")
      },
      description: `Workflow summary for ${input.workflowId}`,
      keywords: ["workflow", input.workflowId, input.taskName, input.result.status],
      workflowId: input.workflowId,
      runId: input.runId,
      sourceTask: input.taskName,
      phase: input.phase,
      taskType: input.taskType
    };
  }

  private async materializeRecord(
    input: MemoryRecordInput,
    now: number,
    importance: number,
    createdAt: number,
  ): Promise<MemoryRecord> {
    const id = input.id ?? `memory.${input.shard}.${input.kind}.${randomUUID().slice(0, 12)}`;
    const enrichedPayload = await enrichPayloadWithEmbedding(
      input.payload,
      input.shard,
      this.embeddingProvider,
    );
    const embedding =
      input.embedding ??
      (input.shard === "knowledge" && "embedding" in enrichedPayload
        ? enrichedPayload.embedding
        : (await this.embeddingProvider.embed(stringifyPayload(enrichedPayload, input.description))).embedding);
    const embeddingModelId =
      input.embeddingModelId ??
      (await this.embeddingProvider.embed(input.description)).modelId;

    return {
      id,
      shard: input.shard,
      kind: input.kind,
      payload: enrichedPayload,
      description: input.description,
      keywords: uniqueStrings(input.keywords ?? []),
      importance,
      createdAt,
      updatedAt: now,
      lastAccessedAt: now,
      embedding,
      embeddingModelId,
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.sourceTask ? { sourceTask: input.sourceTask } : {}),
      ...(input.phase ? { phase: input.phase } : {}),
      ...(input.taskType ? { taskType: input.taskType } : {}),
      ...(input.supersedes ? { supersedes: [...input.supersedes] } : {})
    };
  }

  private async persistRecord(record: MemoryRecord): Promise<void> {
    await this.kvStore.put(record);
    if (record.embedding) {
      await this.vectorStore.upsert({
        id: record.id,
        embedding: record.embedding,
        ...(record.archivedAt ? { archived: true } : {})
      });
    }
  }

  private async compressRepeatedEvents(workflowId?: string): Promise<string[]> {
    const rawTaskRecords = (await this.kvStore.list({
      shard: "task",
      kind: "raw",
      archived: false
    })).filter((record) => (workflowId ? record.workflowId === workflowId : true));

    const groups = new Map<string, MemoryRecord[]>();
    for (const record of rawTaskRecords) {
      const key = `${record.workflowId ?? "-"}::${record.description}`;
      const bucket = groups.get(key) ?? [];
      bucket.push(record);
      groups.set(key, bucket);
    }

    const compressedIds: string[] = [];
    for (const records of groups.values()) {
      if (records.length < REPEATED_EVENT_THRESHOLD) {
        continue;
      }

      const representative = records[0];
      if (!representative) {
        continue;
      }

      const summaryId = `memory.task.summary.compressed.${hashString(representative.description)}.${representative.workflowId ?? "global"}`;
      const summaryInput: MemoryRecordInput = {
        id: summaryId,
        shard: "task",
        kind: "summary",
        payload: {
          taskId: representative.sourceTask ?? representative.id,
          status: "failed",
          input: null,
          output: `${records.length} repeated task events compressed`,
          errors: records
            .flatMap((record) =>
              isTaskMemory(record.payload) ? record.payload.errors : [],
            )
            .slice(0, 5),
          updatedAt: Date.now()
        },
        description: `Compressed repeated task events: ${representative.description}`,
        keywords: uniqueStrings([
          ...(representative.keywords ?? []),
          "compressed",
          "summary"
        ]),
        importance: 0.85,
        ...(representative.workflowId ? { workflowId: representative.workflowId } : {}),
        ...(representative.runId ? { runId: representative.runId } : {}),
        ...(representative.sourceTask ? { sourceTask: representative.sourceTask } : {}),
        ...(representative.phase ? { phase: representative.phase } : {}),
        ...(representative.taskType ? { taskType: representative.taskType } : {})
      };
      const disposition = await this.write(summaryInput);
      if (disposition.recordId) {
        compressedIds.push(disposition.recordId);
      }

      for (const record of records) {
        if (disposition.recordId) {
          await this.graphStore.addEdge({
            from: record.id,
            to: disposition.recordId,
            relation: "compressed-into"
          });
        }
      }
    }

    return compressedIds;
  }
}

type ObservedMemoryEngineArgs = {
  engine: MemoryEngine;
  broadcaster: ExecutionBroadcaster;
  workflowId: string;
  runId: string;
  now: () => number;
};

export function createObservedMemoryEngine(args: ObservedMemoryEngineArgs): MemoryEngine {
  const emit = async (
    type: MemoryEventType,
    summary: string,
    meta?: Record<string, unknown>,
  ): Promise<void> => {
    const event: ExecutionEvent = {
      type,
      timestamp: args.now(),
      workflowId: args.workflowId,
      runId: args.runId,
      summary,
      ...(meta ? { meta } : {})
    };
    await args.broadcaster.emit(event);
  };

  return {
    async beforeStep(input) {
      const context = await args.engine.beforeStep(input);
      await emit("memory.before_step", `beforeStep ${input.taskName}`, {
        taskName: input.taskName,
        taskType: input.taskType,
        phase: input.phase,
        routedShards: context.routedShards,
        usedTokens: context.usedTokens
      });
      return context;
    },
    async afterStep(input) {
      const report = await args.engine.afterStep(input);
      await emit("memory.after_step", `afterStep ${input.taskName}`, {
        taskName: input.taskName,
        taskRecordAction: report.taskRecord.action,
        workflowRecordAction: report.workflowRecord.action,
        compressedIds: report.compressedIds
      });
      return report;
    },
    async write(record) {
      const disposition = await args.engine.write(record);
      const eventType =
        disposition.action === "merge"
          ? "memory.merge"
          : disposition.action === "compress"
            ? "memory.compress"
            : "memory.write";
      await emit(eventType, `${disposition.action} ${record.shard}/${record.kind}`, {
        recordId: disposition.recordId,
        targetId: disposition.targetId,
        reason: disposition.reason,
        importance: disposition.importance,
        similarityScore: disposition.similarityScore
      });
      if (disposition.warningCode) {
        await emit("memory.warning", `${disposition.warningCode} ${disposition.reason}`, {
          code: disposition.warningCode,
          action: disposition.action,
          recordId: disposition.recordId,
          targetId: disposition.targetId,
          reason: disposition.reason,
          importance: disposition.importance,
          similarityScore: disposition.similarityScore
        });
      }
      return disposition;
    },
    async get(id) {
      return args.engine.get(id);
    },
    async retrieve(request) {
      const result = await args.engine.retrieve(request);
      await emit("retrieval.performed", `retrieve ${request.taskType}`, {
        query: request.query,
        routedShards: result.routedShards,
        hitCount: result.hits.length,
        usedTokens: result.usedTokens
      });
      return result;
    },
    async getStats(filter) {
      return args.engine.getStats(filter);
    },
    async flush(filter) {
      return args.engine.flush(filter);
    },
    async runLifecycle(now) {
      const report = await args.engine.runLifecycle(now);
      if (report.compressedIds.length > 0) {
        await emit("memory.compress", "lifecycle compress", {
          compressedIds: report.compressedIds
        });
      }
      if (report.archivedIds.length > 0) {
        await emit("memory.archive", "lifecycle archive", {
          archivedIds: report.archivedIds
        });
        await emit(
          "memory.warning",
          `lifecycle archive ${report.archivedIds.length} record(s) archived`,
          {
          code: "lifecycle_archive",
          archivedIds: report.archivedIds,
          reason: `${report.archivedIds.length} record(s) archived by lifecycle`
          }
        );
      }
      if (report.expiredIds.length > 0 || report.deletedIds.length > 0) {
        await emit("memory.expire", "lifecycle expire", {
          expiredIds: report.expiredIds,
          deletedIds: report.deletedIds
        });
        if (report.deletedIds.length > 0) {
          await emit(
            "memory.warning",
            `lifecycle delete ${report.deletedIds.length} record(s) deleted`,
            {
              code: "lifecycle_delete",
              deletedIds: report.deletedIds,
              expiredIds: report.expiredIds,
              reason: `${report.deletedIds.length} record(s) deleted by lifecycle`
            }
          );
        }
      }
      return report;
    },
    async list(query) {
      return args.engine.list(query);
    }
  };
}

function matchesRecordFilter(record: MemoryRecord, filter: MemoryRecordFilter): boolean {
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

function createShardStats(): MemoryStats["byShard"] {
  return {
    user: { total: 0, active: 0, archived: 0, raw: 0, summary: 0 },
    task: { total: 0, active: 0, archived: 0, raw: 0, summary: 0 },
    workflow: { total: 0, active: 0, archived: 0, raw: 0, summary: 0 },
    system: { total: 0, active: 0, archived: 0, raw: 0, summary: 0 },
    knowledge: { total: 0, active: 0, archived: 0, raw: 0, summary: 0 }
  };
}

function createKindStats(): MemoryStats["byKind"] {
  return {
    raw: { total: 0, active: 0, archived: 0 },
    summary: { total: 0, active: 0, archived: 0 }
  };
}

function buildStepQuery(input: BeforeStepInput): string {
  return [
    input.currentStep,
    input.taskName,
    input.taskType,
    input.phase,
    safeJson(input.input)
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeQuery(value)
    .split(/[^a-z0-9_]+/iu)
    .map((token) => token.trim())
    .filter(Boolean);
}

function computeKeywordScore(record: MemoryRecord, normalizedQuery: string): number {
  const queryTokens = tokenize(normalizedQuery);
  if (queryTokens.length === 0) {
    return 0;
  }

  const haystack = normalizeQuery(
    `${record.description} ${record.keywords.join(" ")} ${safeJson(record.payload)}`,
  );
  const matches = queryTokens.filter((token) => haystack.includes(token)).length;
  return matches / queryTokens.length;
}

function computeRecencyScore(record: MemoryRecord): number {
  const age = Date.now() - record.lastAccessedAt;
  return clamp01(1 - age / (30 * DAY_MS));
}

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return clamp01(dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)));
}

function calculateImportance(record: MemoryRecordInput, novelty: number): number {
  const relevance = calculateRelevance(record);
  const reuseProbability = calculateReuseProbability(record);
  const impact = calculateImpact(record);
  return (relevance + reuseProbability + impact + novelty) / 4;
}

function calculateRelevance(record: MemoryRecordInput): number {
  if (record.shard === "system" || record.shard === "knowledge") {
    return 0.9;
  }

  if (record.shard === "workflow" || record.kind === "summary") {
    return 0.8;
  }

  if (record.shard === "task") {
    return 0.7;
  }

  return 0.6;
}

function calculateReuseProbability(record: MemoryRecordInput): number {
  switch (record.shard) {
    case "knowledge":
      return 0.9;
    case "user":
    case "system":
      return 0.8;
    case "workflow":
      return 0.7;
    case "task":
      return 0.6;
  }
}

function calculateImpact(record: MemoryRecordInput): number {
  const serialized = `${record.description} ${safeJson(record.payload)}`.toLowerCase();
  if (serialized.includes("error") || serialized.includes("failed")) {
    return 1;
  }

  if (record.kind === "summary") {
    return 0.8;
  }

  if (record.shard === "workflow" || record.shard === "knowledge") {
    return 0.75;
  }

  return 0.6;
}

function findSimilarityMatch(
  record: MemoryRecordInput,
  candidates: MemoryRecord[],
  normalizedContent: string,
): { record: MemoryRecord; score: number } | null {
  let best: { record: MemoryRecord; score: number } | null = null;
  for (const candidate of candidates) {
    if (record.id && candidate.id === record.id) {
      continue;
    }

    const score = keywordSimilarity(
      normalizedContent,
      stringifyPayload(candidate.payload, candidate.description),
    );
    if (!best || score > best.score) {
      best = {
        record: candidate,
        score
      };
    }
  }

  return best;
}

function keywordSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

function mergeRecords(
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
    supersedes: uniqueStrings([...(current.supersedes ?? []), current.id])
  };
}

function mergePayload(current: MemoryRecord["payload"], next: MemoryRecordInput["payload"]) {
  if (isWorkflowMemory(current) && isWorkflowMemory(next)) {
    return {
      ...current,
      currentStep: next.currentStep,
      history: [...current.history, ...next.history],
      contextSummary: next.contextSummary
    } satisfies WorkflowMemory;
  }

  if (isTaskMemory(current) && isTaskMemory(next)) {
    return {
      ...current,
      status: next.status,
      input: next.input,
      output: next.output,
      errors: uniqueStrings([...current.errors, ...next.errors]),
      updatedAt: next.updatedAt
    } satisfies TaskMemory;
  }

  return next;
}

async function enrichPayloadWithEmbedding(
  payload: MemoryRecordInput["payload"],
  shard: MemoryShard,
  provider: EmbeddingProvider,
) {
  if (shard !== "knowledge") {
    return payload;
  }

  const knowledge = payload as KnowledgeMemory;
  if (Array.isArray(knowledge.embedding) && knowledge.embedding.length > 0) {
    return knowledge;
  }

  const embedded = await provider.embed(knowledge.content);
  return {
    ...knowledge,
    embedding: embedded.embedding
  } satisfies KnowledgeMemory;
}

function buildTaskPayload(input: AfterStepInput): TaskMemory {
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
    updatedAt: input.now
  };
}

function summarizeWorkflowStep(input: AfterStepInput): string {
  if (input.result.error?.message) {
    return `${input.taskName} failed: ${input.result.error.message}`;
  }

  return `${input.taskName} ${input.result.status}`;
}

function routeMemory(taskType: MemoryTaskType): MemoryShard[] {
  switch (taskType) {
    case "user":
      return ["user"];
    case "workflow":
      return ["workflow", "task"];
    case "debug":
      return ["task", "knowledge"];
    default:
      return ["knowledge"];
  }
}

function assembleContext(args: {
  hits: RetrieveHit[];
  phase: MemoryPhase;
  maxTokens: number;
}): { assembledContext: string; usedTokens: number } {
  const lines = [`Phase: ${args.phase}`];
  let usedTokens = estimateTokens(lines.join("\n"));

  const shardPriority = phasePriority(args.phase);
  const ordered = [...args.hits].sort((left, right) => {
    const shardDelta =
      shardPriority.indexOf(left.record.shard) - shardPriority.indexOf(right.record.shard);
    if (shardDelta !== 0) {
      return shardDelta;
    }

    if (left.record.kind !== right.record.kind) {
      return left.record.kind === "summary" ? -1 : 1;
    }

    return right.finalScore - left.finalScore;
  });

  for (const hit of ordered) {
    const line = `[${hit.record.shard}/${hit.record.kind}] ${hit.record.description}: ${truncateForContext(hit.record.payload)}`;
    const cost = estimateTokens(line);
    if (usedTokens + cost > args.maxTokens) {
      break;
    }

    lines.push(line);
    usedTokens += cost;
  }

  return {
    assembledContext: lines.join("\n"),
    usedTokens
  };
}

function phasePriority(phase: MemoryPhase): MemoryShard[] {
  switch (phase) {
    case "PLANNING":
      return ["system", "knowledge", "workflow", "user", "task"];
    case "EXECUTION":
      return ["task", "workflow", "system", "user", "knowledge"];
    case "REFLECTION":
      return ["workflow", "task", "user", "knowledge", "system"];
    case "RECOVERY":
      return ["task", "system", "workflow", "knowledge", "user"];
  }
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function truncateForContext(payload: MemoryRecord["payload"]): string {
  const text = safeJson(payload);
  if (text.length <= 240) {
    return text;
  }

  return `${text.slice(0, 237)}...`;
}

function stringifyPayload(payload: MemoryRecord["payload"], description: string): string {
  return `${description} ${safeJson(payload)}`;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(toSerializableValue(value));
  } catch {
    return String(value);
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hashString(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 12);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

async function linkSupersedes(
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
    relation
  });
}

function isTaskMemory(payload: MemoryRecord["payload"]): payload is TaskMemory {
  return "taskId" in payload;
}

function isWorkflowMemory(payload: MemoryRecord["payload"]): payload is WorkflowMemory {
  return "contextSummary" in payload && "history" in payload;
}
