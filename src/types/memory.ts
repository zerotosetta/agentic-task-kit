import type { TaskResult, TaskStatus, WorkflowInput } from "./core.js";

export type MemoryShard = "user" | "task" | "workflow" | "system" | "knowledge";

export type MemoryKind = "raw" | "summary";

export type MemoryPhase = "PLANNING" | "EXECUTION" | "REFLECTION" | "RECOVERY";

export type MemoryTaskType = "user" | "workflow" | "debug" | "default";

export type MemorySimilarWriteAction = "overwrite" | "merge" | "discard";

export type MemoryWritePolicy = {
  similarWriteAction?: MemorySimilarWriteAction;
  similarityThreshold?: number;
};

export type MemoryWarningCode =
  | "similar_overwrite"
  | "similar_merge"
  | "similar_discard"
  | "low_importance_discard"
  | "lifecycle_archive"
  | "lifecycle_delete";

export type StepExecutionLog = {
  stepName: string;
  status: TaskStatus;
  startedAt: number;
  endedAt?: number;
  summary?: string;
  error?: string;
};

export type UserMemory = {
  userId: string;
  preferences: string[];
  behaviorPatterns: string[];
  lastUpdated: number;
};

export type TaskMemory = {
  taskId: string;
  status: "pending" | "running" | "done" | "failed";
  input: unknown;
  output: unknown;
  errors: string[];
  updatedAt: number;
};

export type WorkflowMemory = {
  workflowId: string;
  currentStep: string;
  history: StepExecutionLog[];
  contextSummary: string;
};

export type SystemMemory = {
  policies: string[];
  constraints: string[];
};

export type KnowledgeMemory = {
  id: string;
  content: string;
  embedding: number[];
  tags: string[];
};

export type MemoryPayload =
  | UserMemory
  | TaskMemory
  | WorkflowMemory
  | SystemMemory
  | KnowledgeMemory;

export type MemoryRecord = {
  id: string;
  shard: MemoryShard;
  kind: MemoryKind;
  payload: MemoryPayload;
  description: string;
  keywords: string[];
  importance: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  embedding?: number[];
  embeddingModelId?: string;
  workflowId?: string;
  runId?: string;
  sourceTask?: string;
  phase?: MemoryPhase;
  taskType?: MemoryTaskType;
  supersedes?: string[];
  archivedAt?: number;
};

export type MemoryRecordInput = {
  id?: string;
  shard: MemoryShard;
  kind: MemoryKind;
  payload: MemoryPayload;
  description: string;
  keywords?: string[];
  importance?: number;
  embedding?: number[];
  embeddingModelId?: string;
  workflowId?: string;
  runId?: string;
  sourceTask?: string;
  phase?: MemoryPhase;
  taskType?: MemoryTaskType;
  supersedes?: string[];
  similarWriteAction?: MemorySimilarWriteAction;
};

export type MemoryRecordFilter = {
  shard?: MemoryShard;
  kind?: MemoryKind;
  archived?: boolean;
  workflowId?: string;
  runId?: string;
  sourceTask?: string;
};

export type MemoryHeapStats = {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
};

export type MemoryStats = {
  heap: MemoryHeapStats;
  totalRecords: number;
  activeRecords: number;
  archivedRecords: number;
  byShard: Record<
    MemoryShard,
    {
      total: number;
      active: number;
      archived: number;
      raw: number;
      summary: number;
    }
  >;
  byKind: Record<
    MemoryKind,
    {
      total: number;
      active: number;
      archived: number;
    }
  >;
};

export type RetrieveRequest = {
  query: string;
  taskType: MemoryTaskType;
  phase: MemoryPhase;
  topK?: number;
  maxContextTokens?: number;
  /** Scoped retrieval is applied before ranking/topK. Unscoped calls retain global retrieval. */
  scope?: { workflowId: string; runId?: string; includeGlobal?: boolean };
};

export type RetrieveHit = {
  record: MemoryRecord;
  semanticScore: number;
  keywordScore: number;
  recencyScore: number;
  importanceScore: number;
  finalScore: number;
};

export type RetrieveResult = {
  query: string;
  normalizedQuery: string;
  routedShards: MemoryShard[];
  hits: RetrieveHit[];
  assembledContext: string;
  usedTokens: number;
  maxTokens: number;
};

export type StepMemoryContext = RetrieveResult & {
  currentStep: string;
  taskName: string;
  phase: MemoryPhase;
  taskType: MemoryTaskType;
};

export type WriteDispositionAction =
  | "discard"
  | "create"
  | "overwrite"
  | "merge"
  | "compress"
  | "archive"
  | "delete";

export type WriteDisposition = {
  action: WriteDispositionAction;
  recordId?: string;
  targetId?: string;
  reason: string;
  importance: number;
  similarityScore?: number;
  warningCode?: MemoryWarningCode;
};

export type MemoryWriteReport = {
  taskRecord: WriteDisposition;
  workflowRecord: WriteDisposition;
  compressedIds: string[];
  discardedIds: string[];
};

export type LifecycleReport = {
  archivedIds: string[];
  deletedIds: string[];
  compressedIds: string[];
  expiredIds: string[];
};

export type MemoryFlushReport = {
  deletedIds: string[];
  deletedArchivedIds: string[];
  remainingActive: number;
  remainingArchived: number;
  filters: MemoryRecordFilter;
};

export type BeforeStepInput = {
  workflowId: string;
  runId: string;
  currentStep: string;
  taskName: string;
  taskType: MemoryTaskType;
  phase: MemoryPhase;
  input: WorkflowInput;
  now: number;
};

export type AfterStepInput = BeforeStepInput & {
  result: TaskResult;
};

export interface KVStore {
  put(record: MemoryRecord): Promise<void>;
  get(id: string): Promise<MemoryRecord | null>;
  delete(id: string): Promise<void>;
  archive(id: string, archivedAt: number): Promise<MemoryRecord | null>;
  list(args?: {
    shard?: MemoryShard;
    kind?: MemoryKind;
    archived?: boolean;
  }): Promise<MemoryRecord[]>;
}

export interface VectorStore {
  upsert(args: { id: string; embedding: number[]; archived?: boolean }): Promise<void>;
  delete(id: string, archived?: boolean): Promise<void>;
  search(args: {
    embedding: number[];
    topK: number;
    ids?: string[];
    archived?: boolean;
  }): Promise<Array<{ id: string; score: number }>>;
}

export interface GraphStore {
  addEdge(args: {
    from: string;
    to: string;
    relation: "supersedes" | "merged-into" | "compressed-into" | "archived-from" | "workflow-step";
    meta?: Record<string, unknown>;
  }): Promise<void>;
  listEdges(id: string): Promise<
    Array<{
      from: string;
      to: string;
      relation: string;
      meta?: Record<string, unknown>;
    }>
  >;
  delete(id: string): Promise<void>;
}

export interface EmbeddingProvider {
  embed(text: string): Promise<{ embedding: number[]; modelId: string }>;
}

export interface MemoryEngine {
  beforeStep(input: BeforeStepInput): Promise<StepMemoryContext>;
  afterStep(input: AfterStepInput): Promise<MemoryWriteReport>;
  write(record: MemoryRecordInput): Promise<WriteDisposition>;
  get(id: string): Promise<MemoryRecord | null>;
  retrieve(request: RetrieveRequest): Promise<RetrieveResult>;
  getStats(filter?: MemoryRecordFilter): Promise<MemoryStats>;
  flush(filter?: MemoryRecordFilter): Promise<MemoryFlushReport>;
  runLifecycle(now?: number): Promise<LifecycleReport>;
  list(args?: MemoryRecordFilter): Promise<MemoryRecord[]>;
}
