import { randomUUID } from "node:crypto";
import type {
  AfterStepInput,
  BeforeStepInput,
  EmbeddingProvider,
  GraphStore,
  KVStore,
  LifecycleReport,
  MemoryEngine,
  MemoryFlushReport,
  MemoryRecord,
  MemoryRecordFilter,
  MemoryRecordInput,
  MemorySimilarWriteAction,
  MemoryStats,
  MemoryWritePolicy,
  MemoryWriteReport,
  RetrieveHit,
  RetrieveRequest,
  RetrieveResult,
  StepExecutionLog,
  StepMemoryContext,
  VectorStore,
  WorkflowMemory,
  WriteDisposition,
} from "../types.js";
import { assembleContext, buildStepQuery, routeMemory } from "./context.js";
import {
  buildTaskPayload,
  createKindStats,
  createShardStats,
  isTaskMemory,
  linkSupersedes,
  matchesRecordFilter,
  mergeRecords,
  resolveRecordEmbedding,
  summarizeWorkflowStep,
} from "./records.js";
import {
  calculateImportance,
  clamp01,
  computeKeywordScore,
  computeRecencyScore,
  DAY_MS,
  findSimilarityMatch,
  normalizeQuery,
} from "./scoring.js";
import {
  DeterministicHashEmbeddingProvider,
  InMemoryGraphStore,
  InMemoryKVStore,
  InMemoryVectorStore,
} from "./stores.js";
import { hashString, stringifyPayload, uniqueStrings } from "./text.js";

const DEFAULT_MAX_CONTEXT_TOKENS = 8_192;

const DEFAULT_SIMILARITY_THRESHOLD = 0.85;

const DEFAULT_SIMILAR_WRITE_ACTION: MemorySimilarWriteAction = "overwrite";

const REPEATED_EVENT_THRESHOLD = 3;

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
    this.embeddingProvider = options.embeddingProvider ?? new DeterministicHashEmbeddingProvider();
    this.maxContextTokens = options.maxContextTokens ?? DEFAULT_MAX_CONTEXT_TOKENS;
    this.writePolicy = {
      similarWriteAction: options.writePolicy?.similarWriteAction ?? DEFAULT_SIMILAR_WRITE_ACTION,
      similarityThreshold: options.writePolicy?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD,
    };
  }

  async beforeStep(input: BeforeStepInput): Promise<StepMemoryContext> {
    const query = buildStepQuery(input);
    const retrieveResult = await this.retrieve({
      query,
      taskType: input.taskType,
      phase: input.phase,
    });

    return {
      ...retrieveResult,
      currentStep: input.currentStep,
      taskName: input.taskName,
      phase: input.phase,
      taskType: input.taskType,
    };
  }

  async afterStep(input: AfterStepInput): Promise<MemoryWriteReport> {
    const taskRecord = await this.write({
      id: `memory.task.raw.${input.workflowId}.${input.taskName}.${input.runId}.${input.now}`,
      shard: "task",
      kind: "raw",
      payload: buildTaskPayload(input),
      description: `Task execution state for ${input.taskName}`,
      keywords: ["task", input.taskName, input.result.status, input.taskType.toLowerCase()],
      workflowId: input.workflowId,
      runId: input.runId,
      sourceTask: input.taskName,
      phase: input.phase,
      taskType: input.taskType,
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
        workflowRecord.action === "discard" && workflowRecord.recordId
          ? workflowRecord.recordId
          : undefined,
      ].filter((value): value is string => typeof value === "string"),
    };
  }

  async write(record: MemoryRecordInput): Promise<WriteDisposition> {
    const now = Date.now();
    const existing = record.id ? await this.kvStore.get(record.id) : null;
    const candidates = await this.kvStore.list({
      shard: record.shard,
      kind: record.kind,
      archived: false,
    });
    const normalizedContent = stringifyPayload(record.payload, record.description);
    const similarityMatch = findSimilarityMatch(record, candidates, normalizedContent);
    const similarWriteAction = record.similarWriteAction ?? this.writePolicy.similarWriteAction;
    const canApplySimilarityPolicy =
      similarityMatch !== null &&
      similarityMatch.score >= this.writePolicy.similarityThreshold &&
      !(record.shard === "task" && record.kind === "raw");
    const novelty =
      canApplySimilarityPolicy && similarityMatch ? Math.max(0, 1 - similarityMatch.score) : 1;
    const importance = clamp01(record.importance ?? calculateImportance(record, novelty));

    if (existing) {
      const next = await this.materializeRecord(record, now, importance, existing.createdAt);
      await this.persistRecord(next);
      await linkSupersedes(this.graphStore, existing.id, next.id, "supersedes");
      return {
        action: "overwrite",
        recordId: next.id,
        reason: "existing id overwritten",
        importance,
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
          warningCode: "similar_discard",
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
          warningCode: "similar_merge",
        };
      }

      const overwritten = await this.materializeRecord(
        {
          ...record,
          id: similarityMatch.record.id,
          supersedes: uniqueStrings([
            ...(similarityMatch.record.supersedes ?? []),
            ...(record.supersedes ?? []),
          ]),
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
        warningCode: "similar_overwrite",
      };
    }

    if (importance < 0.6) {
      return {
        action: "discard",
        reason: `importance ${importance.toFixed(2)} is below 0.6`,
        importance,
        warningCode: "low_importance_discard",
      };
    }

    const created = await this.materializeRecord(record, now, importance, now);
    await this.persistRecord(created);
    return {
      action: "create",
      recordId: created.id,
      reason: "record created",
      importance,
    };
  }

  async get(id: string): Promise<MemoryRecord | null> {
    const record = await this.kvStore.get(id);
    if (!record) {
      return null;
    }

    const touched = {
      ...record,
      lastAccessedAt: Date.now(),
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
            archived: false,
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
      archived: false,
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
          semanticScore * 0.4 + keywordScore * 0.2 + recencyScore * 0.2 + importanceScore * 0.2;

        return {
          record,
          semanticScore,
          keywordScore,
          recencyScore,
          importanceScore,
          finalScore,
        } satisfies RetrieveHit;
      })
      .filter((hit) => hit.finalScore > 0)
      .sort((left, right) => right.finalScore - left.finalScore)
      .slice(0, topK);

    for (const hit of hits) {
      await this.kvStore.put({
        ...hit.record,
        lastAccessedAt: Date.now(),
      });
    }

    const maxTokens = request.maxContextTokens ?? this.maxContextTokens;
    const { assembledContext, usedTokens } = assembleContext({
      hits,
      phase: request.phase,
      maxTokens,
    });

    return {
      query: request.query,
      normalizedQuery,
      routedShards,
      hits,
      assembledContext,
      usedTokens,
      maxTokens,
    };
  }

  async runLifecycle(now = Date.now()): Promise<LifecycleReport> {
    const archivedIds: string[] = [];
    const deletedIds: string[] = [];
    const expiredIds: string[] = [];
    const compressedIds = await this.compressRepeatedEvents();
    const active = await this.kvStore.list({
      archived: false,
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
              archived: true,
            });
          }
          await this.graphStore.addEdge({
            from: archived.id,
            to: archived.id,
            relation: "archived-from",
            meta: {
              archivedAt: now,
            },
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
      expiredIds,
    };
  }

  async getStats(filter: MemoryRecordFilter = {}): Promise<MemoryStats> {
    const active = await this.list({
      ...filter,
      archived: false,
    });
    const archived = await this.list({
      ...filter,
      archived: true,
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
        arrayBuffers: heapUsage.arrayBuffers,
      },
      totalRecords: records.length,
      activeRecords: active.length,
      archivedRecords: archived.length,
      byShard,
      byKind,
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
        archived: false,
      });
      for (const record of activeRecords) {
        await purge(record, false);
      }
    }

    if (deleteArchived) {
      const archivedRecords = await this.list({
        ...filter,
        archived: true,
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
      filters: { ...filter },
    };
  }

  async list(args: MemoryRecordFilter = {}): Promise<MemoryRecord[]> {
    const base = await this.kvStore.list({
      ...(args.shard ? { shard: args.shard } : {}),
      ...(args.kind ? { kind: args.kind } : {}),
      ...(args.archived !== undefined ? { archived: args.archived } : {}),
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
        ...(input.result.error?.message ? { error: input.result.error.message } : {}),
      },
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
          .join(", "),
      },
      description: `Workflow summary for ${input.workflowId}`,
      keywords: ["workflow", input.workflowId, input.taskName, input.result.status],
      workflowId: input.workflowId,
      runId: input.runId,
      sourceTask: input.taskName,
      phase: input.phase,
      taskType: input.taskType,
    };
  }

  private async materializeRecord(
    input: MemoryRecordInput,
    now: number,
    importance: number,
    createdAt: number,
  ): Promise<MemoryRecord> {
    const id = input.id ?? `memory.${input.shard}.${input.kind}.${randomUUID().slice(0, 12)}`;
    const {
      payload: enrichedPayload,
      embedding,
      embeddingModelId,
    } = await resolveRecordEmbedding(input, this.embeddingProvider);

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
      ...(input.supersedes ? { supersedes: [...input.supersedes] } : {}),
    };
  }

  private async persistRecord(record: MemoryRecord): Promise<void> {
    await this.kvStore.put(record);
    if (record.embedding) {
      await this.vectorStore.upsert({
        id: record.id,
        embedding: record.embedding,
        ...(record.archivedAt ? { archived: true } : {}),
      });
    }
  }

  private async compressRepeatedEvents(workflowId?: string): Promise<string[]> {
    const rawTaskRecords = (
      await this.kvStore.list({
        shard: "task",
        kind: "raw",
        archived: false,
      })
    ).filter((record) => (workflowId ? record.workflowId === workflowId : true));

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
            .flatMap((record) => (isTaskMemory(record.payload) ? record.payload.errors : []))
            .slice(0, 5),
          updatedAt: Date.now(),
        },
        description: `Compressed repeated task events: ${representative.description}`,
        keywords: uniqueStrings([...(representative.keywords ?? []), "compressed", "summary"]),
        importance: 0.85,
        ...(representative.workflowId ? { workflowId: representative.workflowId } : {}),
        ...(representative.runId ? { runId: representative.runId } : {}),
        ...(representative.sourceTask ? { sourceTask: representative.sourceTask } : {}),
        ...(representative.phase ? { phase: representative.phase } : {}),
        ...(representative.taskType ? { taskType: representative.taskType } : {}),
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
            relation: "compressed-into",
          });
        }
      }
    }

    return compressedIds;
  }
}
