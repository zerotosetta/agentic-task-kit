import type {
  ExecutionEvent,
  TaskLogEvent,
  TaskLogLevel,
  TaskLogger
} from "./types.js";
import { ExecutionBroadcaster } from "./events.js";

type TaskLoggerArgs = {
  broadcaster: ExecutionBroadcaster;
  workflowId: string;
  runId: string;
  taskName?: string;
  branchId?: string;
  now: () => number;
};

function buildTaskLogEvent(
  args: TaskLoggerArgs,
  level: TaskLogLevel,
  message: string,
  meta?: Record<string, unknown>
): TaskLogEvent {
  const event: TaskLogEvent = {
    timestamp: args.now(),
    workflowId: args.workflowId,
    runId: args.runId,
    level,
    message
  };

  if (args.taskName !== undefined) {
    event.taskName = args.taskName;
  }

  if (args.branchId !== undefined) {
    event.branchId = args.branchId;
  }

  if (meta !== undefined) {
    event.meta = meta;
  }

  return event;
}

function toExecutionEvent(event: TaskLogEvent): ExecutionEvent {
  const executionEvent: ExecutionEvent = {
    type: "task.log",
    timestamp: event.timestamp,
    workflowId: event.workflowId,
    runId: event.runId,
    summary: event.message
  };

  if (event.taskName !== undefined) {
    executionEvent.taskName = event.taskName;
  }

  if (event.branchId !== undefined) {
    executionEvent.branchId = event.branchId;
  }

  executionEvent.meta = {
      ...event.meta,
      level: event.level
  };

  return executionEvent;
}

export function createTaskLogger(args: TaskLoggerArgs): TaskLogger {
  const emit = (event: TaskLogEvent): void => {
    void args.broadcaster.emitTaskLog(event);
    void args.broadcaster.emit(toExecutionEvent(event));
  };

  return {
    emit,
    debug(message, meta) {
      emit(buildTaskLogEvent(args, "debug", message, meta));
    },
    info(message, meta) {
      emit(buildTaskLogEvent(args, "info", message, meta));
    },
    warn(message, meta) {
      emit(buildTaskLogEvent(args, "warn", message, meta));
    },
    error(message, meta) {
      emit(buildTaskLogEvent(args, "error", message, meta));
    },
    success(message, meta) {
      emit(buildTaskLogEvent(args, "success", message, meta));
    }
  };
}
