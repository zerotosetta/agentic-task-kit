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

export type MemoryScope = "task" | "workflow" | "episodic" | "semantic";

export type MemoryCategory =
  | "fact"
  | "decision"
  | "summary"
  | "error"
  | "artifact"
  | "context";

export type MemoryPiece = {
  key: string;
  scope: MemoryScope;
  category: MemoryCategory;
  description: string;
  keywords: string[];
  value: unknown;
  embedding?: number[];
  embeddingModelId?: string;
  importance: number;
  createdAt: number;
  updatedAt: number;
  ttlMs?: number;
  sourceTask?: string;
  hash?: string;
  supersedes?: string[];
};

export type HybridSearchParams = {
  topK: number;
  candidateKKeyword: number;
  candidateKVector: number;
  alpha: number;
  beta: number;
  recencyGamma?: number;
  importanceDelta?: number;
  fusion?: "weighted_sum" | "rrf";
};

export type HybridSearchHit = {
  piece: MemoryPiece;
  keywordScore?: number;
  vectorScore?: number;
  finalScore: number;
};

export type Artifact = {
  artifactId: string;
  name: string;
  mimeType: string;
  uri: string;
  createdAt: number;
  meta?: Record<string, unknown>;
};

export type AISessionMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type AISession = {
  sessionId: string;
  llmModelId: string;
  embeddingModelId: string;
  messages: AISessionMessage[];
  fork: (opts?: { label?: string }) => AISession;
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
      type: "task.queued" | "task.started" | "task.completed" | "task.failed" | "task.retry_scheduled";
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
      type: "memory.put" | "memory.delete" | "retrieval.performed" | "artifact.created" | "task.log";
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
  mode?: "off" | "line" | "compact" | "dashboard" | "jsonl" | "plain";
  stream?: NodeJS.WriteStream;
  errorStream?: NodeJS.WriteStream;
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

export interface MemoryStore {
  put(piece: MemoryPiece): Promise<void>;
  get(key: string): Promise<MemoryPiece | null>;
  delete(key: string): Promise<void>;
  hybridSearch(query: string, params: HybridSearchParams): Promise<HybridSearchHit[]>;
  listByScope(scope: MemoryScope): Promise<MemoryPiece[]>;
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
  memory: MemoryStore;
  artifacts: ArtifactStore;
  log: TaskLogger;
  now: () => number;
}

export type RunOptions = {
  rag?: Array<{ id?: string; text: string; meta?: Record<string, unknown> }>;
  memoryInjection?: MemoryPiece[];
  durable?: boolean;
  observers?: ExecutionObserver[];
};

export interface Cycle {
  register(key: string, workflow: WorkflowDefinition): void;
  run(
    key: string,
    input: unknown,
    options?: RunOptions
  ): Promise<{ frame: ExecutionFrame }>;
}

export type CycleOptions = {
  memoryStore?: MemoryStore;
  artifactStore?: ArtifactStore;
  observers?: ExecutionObserver[];
  now?: () => number;
  llmModelId?: string;
  embeddingModelId?: string;
};
