import type { AIProvider, AISession } from "./ai.js";
import type { ArtifactStore, RunArtifact } from "./artifacts.js";
import type { TaskResult, TaskStatus, WorkflowInput } from "./core.js";
import type {
  EmbeddingProvider,
  GraphStore,
  KVStore,
  LifecycleReport,
  MemoryEngine,
  MemoryFlushReport,
  MemoryPhase,
  MemoryRecord,
  MemoryRecordInput,
  MemoryStats,
  MemoryTaskType,
  MemoryWritePolicy,
  StepMemoryContext,
  VectorStore,
} from "./memory.js";
import type { ExecutionHistorySnapshot, ExecutionObserver, TaskLogger } from "./observability.js";

export type JoinPolicy =
  | { type: "all" }
  | { type: "any" }
  | { type: "quorum"; successCount: number }
  | {
      type: "custom";
      decide: (args: { results: Record<string, TaskResult>; ctx: WorkflowContext }) => boolean;
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

export interface WorkflowCancellation {
  signal: AbortSignal;
  reason: unknown;
  isCancellationRequested(): boolean;
  throwIfRequested(): void;
}

export interface WorkflowRuntimeController {
  hasActiveRuns(): boolean;
  cancelActiveRuns(reason?: string): Promise<number>;
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
  input: WorkflowInput;
  session: AISession;
  ai: AIProvider;
  memory: MemoryEngine;
  memoryContext?: StepMemoryContext;
  artifacts: ArtifactStore;
  log: TaskLogger;
  cancellation: WorkflowCancellation;
  now: () => number;
  runSubWorkflow(
    key: string,
    input: WorkflowInput,
    options?: SubWorkflowRunOptions,
  ): Promise<CycleRunResult>;
}

export type RunOptions = {
  rag?: Array<{ id?: string; text: string; meta?: Record<string, unknown> }>;
  memoryInjection?: MemoryRecordInput[];
  durable?: boolean;
  observers?: ExecutionObserver[];
};

export type SubWorkflowRunOptions = Omit<RunOptions, "observers"> & {
  branchId?: string;
  summary?: string;
};

export type CycleRunMemorySnapshot = {
  records: MemoryRecord[];
  activeRecords: MemoryRecord[];
  archivedRecords: MemoryRecord[];
  lifecycle: LifecycleReport;
  stats: MemoryStats;
};

export type CycleRunArtifactSnapshot = {
  artifacts: RunArtifact[];
};

export type CycleRunResult = {
  frame: ExecutionFrame;
  memory: CycleRunMemorySnapshot;
  artifacts: CycleRunArtifactSnapshot;
  history: ExecutionHistorySnapshot;
  flushMemory: () => Promise<MemoryFlushReport>;
};

export interface Cycle extends WorkflowRuntimeController {
  register(key: string, workflow: WorkflowDefinition): void;
  run(key: string, input: WorkflowInput, options?: RunOptions): Promise<CycleRunResult>;
}

export type CycleOptions = {
  aiProvider?: AIProvider;
  memoryEngine?: MemoryEngine;
  memoryWritePolicy?: MemoryWritePolicy;
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
