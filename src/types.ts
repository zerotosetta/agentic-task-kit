export type TaskStatus = "success" | "fail" | "retry" | "skip" | (string & {});

export type TaskResult<T = unknown> = {
  status: TaskStatus;
  output?: T;
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
};

export type MemoryShard = "user" | "task" | "workflow" | "system" | "knowledge";

export type MemoryKind = "raw" | "summary";

export type MemoryPhase = "PLANNING" | "EXECUTION" | "REFLECTION" | "RECOVERY";

export type MemoryTaskType = "user" | "workflow" | "debug" | "default";

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
};

export type RetrieveRequest = {
  query: string;
  taskType: MemoryTaskType;
  phase: MemoryPhase;
  topK?: number;
  maxContextTokens?: number;
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

export type BeforeStepInput = {
  workflowId: string;
  runId: string;
  currentStep: string;
  taskName: string;
  taskType: MemoryTaskType;
  phase: MemoryPhase;
  input: unknown;
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
  runLifecycle(now?: number): Promise<LifecycleReport>;
  list(args?: {
    shard?: MemoryShard;
    kind?: MemoryKind;
    archived?: boolean;
  }): Promise<MemoryRecord[]>;
}

export type Artifact = {
  artifactId: string;
  name: string;
  mimeType: string;
  uri: string;
  createdAt: number;
  meta?: Record<string, unknown>;
};

export type AIChatMessageRole = "developer" | "system" | "user" | "assistant";

export type AISessionMessage = {
  role: AIChatMessageRole;
  content: string;
  name?: string;
};

export type AISession = {
  sessionId: string;
  llmModelId: string;
  embeddingModelId: string;
  messages: AISessionMessage[];
  fork: (opts?: { label?: string }) => AISession;
};

export type AIReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AIHTTPHeaders = Record<string, string>;

export type AIHTTPRequestOptions = {
  baseURL?: string;
  headers?: AIHTTPHeaders;
  timeoutMs?: number;
  maxRetries?: number;
};

export type AIHTTPDebugLoggingOptions = {
  enabled?: boolean;
  stream?: NodeJS.WritableStream;
  includeHeaders?: boolean;
  includeResponseHeaders?: boolean;
  includeRequestBody?: boolean;
  redactHeaders?: string[];
};

export type AIChatRequest = {
  model?: string;
  messages: AISessionMessage[];
  temperature?: number;
  maxCompletionTokens?: number;
  reasoningEffort?: AIReasoningEffort;
  metadata?: Record<string, string>;
  promptCacheKey?: string;
  http?: AIHTTPRequestOptions;
};

export type AIChatUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
};

export type AIProviderRequestErrorDetails = {
  provider: string;
  model?: string;
  status?: number;
  requestId?: string | null;
  code?: string | null;
  type?: string;
  param?: string | null;
  responseBody?: unknown;
  originalError: unknown;
};

export type AIChatResponse = {
  provider: string;
  model: string;
  outputText: string;
  message: AISessionMessage;
  finishReason?: string | null;
  usage?: AIChatUsage;
  raw?: unknown;
};

export type AIChatStreamChunk = {
  provider: string;
  model: string;
  deltaText: string;
  outputText: string;
  finishReason?: string | null;
  usage?: AIChatUsage;
  raw?: unknown;
};

export interface AIChatStream extends AsyncIterable<AIChatStreamChunk> {
  finalResponse: Promise<AIChatResponse>;
}

export interface AIProvider {
  provider: string;
  defaultChatModel?: string | undefined;
  chat(request: AIChatRequest): Promise<AIChatResponse>;
  chatStream(request: AIChatRequest): Promise<AIChatStream>;
}

export type JoinPolicy =
  | { type: "all" }
  | { type: "any" }
  | { type: "quorum"; successCount: number }
  | {
      type: "custom";
      decide: (args: {
        results: Record<string, TaskResult>;
        ctx: WorkflowContext;
      }) => boolean;
    };

export type ParallelTransition = {
  parallel: string[];
  join: string;
  joinPolicy?: JoinPolicy;
  branchId?: string;
};

export type Transition =
  | string
  | {
      [status in TaskStatus]?: string | ParallelTransition;
    };

export type TaskLogLevel = "debug" | "info" | "warn" | "error" | "success";

export type TaskLogEvent = {
  timestamp: number;
  workflowId: string;
  runId: string;
  taskName?: string;
  branchId?: string;
  level: TaskLogLevel;
  message: string;
  meta?: Record<string, unknown>;
};

export type ExecutionEvent =
  | {
      type: "workflow.started";
      timestamp: number;
      workflowId: string;
      runId: string;
      summary: string;
      meta?: Record<string, unknown>;
    }
  | {
      type: "workflow.completed";
      timestamp: number;
      workflowId: string;
      runId: string;
      summary: string;
      status: string;
      meta?: Record<string, unknown>;
    }
  | {
      type: "workflow.failed";
      timestamp: number;
      workflowId: string;
      runId: string;
      summary: string;
      status: string;
      meta?: Record<string, unknown>;
    }
  | {
      type:
        | "task.queued"
        | "task.started"
        | "task.completed"
        | "task.failed"
        | "task.retry_scheduled";
      timestamp: number;
      workflowId: string;
      runId: string;
      taskName: string;
      summary: string;
      status?: string;
      meta?: Record<string, unknown>;
    }
  | {
      type: "branch.started" | "branch.completed" | "join.waiting" | "join.completed";
      timestamp: number;
      workflowId: string;
      runId: string;
      branchId: string;
      summary: string;
      status?: string;
      meta?: Record<string, unknown>;
    }
  | {
      type:
        | "memory.before_step"
        | "memory.after_step"
        | "memory.write"
        | "memory.merge"
        | "memory.compress"
        | "memory.expire"
        | "memory.archive"
        | "retrieval.performed"
        | "artifact.created"
        | "task.log";
      timestamp: number;
      workflowId: string;
      runId: string;
      summary: string;
      taskName?: string;
      branchId?: string;
      status?: string;
      meta?: Record<string, unknown>;
    };

export interface ExecutionObserver {
  onEvent(event: ExecutionEvent): void | Promise<void>;
  onTaskLog?(event: TaskLogEvent): void | Promise<void>;
  onFlush?(): void | Promise<void>;
}

export interface TaskLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  success(message: string, meta?: Record<string, unknown>): void;
  emit(event: TaskLogEvent): void;
}

export type CLIRendererOptions = {
  enabled?: boolean;
  mode?: "off" | "line" | "compact" | "ink" | "dashboard" | "jsonl" | "plain";
  stream?: NodeJS.WriteStream;
  errorStream?: NodeJS.WriteStream;
  debugLogStream?: NodeJS.ReadableStream;
  useColor?: boolean;
  useUnicode?: boolean;
  refreshMs?: number;
  maxRecentEvents?: number;
  maxRecentLogs?: number;
  logLevel?: TaskLogLevel;
  width?: number;
};

export interface CLIRenderer extends ExecutionObserver {
  start(): void;
  stop(finalStatus?: "success" | "fail"): void;
  resize?(width: number, height: number): void;
}

export interface ArtifactStore {
  create(args: {
    name: string;
    mimeType: string;
    bytes: Uint8Array;
    meta?: Record<string, unknown>;
  }): Promise<Artifact>;
  get(artifactId: string): Promise<Artifact | null>;
  list(prefix?: string): Promise<Artifact[]>;
}

export interface TaskLike {
  name: string;
  memoryPhase: MemoryPhase;
  memoryTaskType: MemoryTaskType;
  before?(ctx: WorkflowContext): Promise<void>;
  run(ctx: WorkflowContext): Promise<TaskResult>;
  after?(ctx: WorkflowContext, result: TaskResult): Promise<void>;
}

export type WorkflowDefinition = {
  name: string;
  start: string;
  end?: string;
  tasks: Record<string, TaskLike>;
  transitions: Record<string, Transition>;
};

export type ExecutionStatus = "running" | "success" | "fail";

export type ExecutionFrame = {
  workflowId: string;
  runId: string;
  currentState: string;
  checkpointSeq: number;
  startedAt: number;
  updatedAt: number;
  status: ExecutionStatus;
  completedTasks: string[];
  failedTasks: string[];
  taskResults: Record<string, TaskResult>;
  errors: string[];
};

export interface WorkflowContext {
  workflowId: string;
  runId: string;
  input: unknown;
  session: AISession;
  ai: AIProvider;
  memory: MemoryEngine;
  memoryContext?: StepMemoryContext;
  artifacts: ArtifactStore;
  log: TaskLogger;
  now: () => number;
}

export type RunOptions = {
  rag?: Array<{ id?: string; text: string; meta?: Record<string, unknown> }>;
  memoryInjection?: MemoryRecordInput[];
  durable?: boolean;
  observers?: ExecutionObserver[];
};

export interface Cycle {
  register(key: string, workflow: WorkflowDefinition): void;
  run(key: string, input: unknown, options?: RunOptions): Promise<{ frame: ExecutionFrame }>;
}

export type CycleOptions = {
  aiProvider?: AIProvider;
  memoryEngine?: MemoryEngine;
  artifactStore?: ArtifactStore;
  observers?: ExecutionObserver[];
  now?: () => number;
  llmModelId?: string;
  embeddingModelId?: string;
  kvStore?: KVStore;
  vectorStore?: VectorStore;
  graphStore?: GraphStore;
  embeddingProvider?: EmbeddingProvider;
  maxMemoryContextTokens?: number;
};

export type OpenAICompatibleChatProviderOptions = {
  providerName?: string;
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  defaultHeaders?: AIHTTPHeaders;
  httpDebugLogging?: boolean | AIHTTPDebugLoggingOptions;
  defaultModel?: string;
  timeoutMs?: number;
  maxRetries?: number;
  defaultTemperature?: number;
  defaultMaxCompletionTokens?: number;
  defaultReasoningEffort?: AIReasoningEffort;
};

export type OpenAICompatibleChatProviderFileConfig = OpenAICompatibleChatProviderOptions & {
  apiKeyEnv?: string;
  baseURLEnv?: string;
  organizationEnv?: string;
  projectEnv?: string;
};

export type OpenAICompatibleChatProviderConfigFileOptions = {
  configPath?: string;
  overrides?: OpenAICompatibleChatProviderOptions;
};

export type OpenAIChatProviderOptions = OpenAICompatibleChatProviderOptions;

export type OpenAIChatProviderFileConfig = OpenAICompatibleChatProviderFileConfig;

export type OpenAIChatProviderConfigFileOptions = OpenAICompatibleChatProviderConfigFileOptions;
