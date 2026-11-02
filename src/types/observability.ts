export type TaskLogLevel = "debug" | "info" | "warn" | "error" | "success";

export type RendererColorName =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "gray";

export type TaskLogColorTheme = Partial<Record<TaskLogLevel, RendererColorName>>;

export type ResolvedTaskLogColorTheme = Record<TaskLogLevel, RendererColorName>;

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
        | "memory.warning"
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
  start?(): void | Promise<void>;
  stop?(finalStatus?: "success" | "fail"): void | Promise<void>;
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

export type ExecutionHistorySnapshot = {
  events: ExecutionEvent[];
  taskLogs: TaskLogEvent[];
  updatedAt?: number;
};

export interface ExecutionHistoryTracker extends ExecutionObserver {
  snapshot(): ExecutionHistorySnapshot;
  subscribe(listener: (snapshot: ExecutionHistorySnapshot) => void): () => void;
  reset(): void;
}
