import type {
  ExecutionEvent,
  TaskLogEvent,
  TaskLogLevel
} from "./types.js";

export type RendererResolvedMode = "line" | "compact" | "ink" | "jsonl" | "plain";

export type TaskHistoryRow = {
  id: string;
  timestamp: number;
  taskName: string;
  phase: "queued" | "started" | "completed" | "failed" | "retry";
  summary: string;
  text: string;
};

export type TimelineRow = {
  id: string;
  timestamp: number;
  level: TaskLogLevel;
  source: "task" | "debug";
  text: string;
  taskName?: string;
};

export type RendererState = {
  workflowId: string | undefined;
  runId: string | undefined;
  status: string | undefined;
  currentTask: string | undefined;
  lastFailure: string | undefined;
  activeTasks: Set<string>;
  completedTasks: string[];
  recentEvents: string[];
  recentLogs: TaskLogEvent[];
  taskHistory: TaskHistoryRow[];
  timeline: TimelineRow[];
  artifactCount: number;
  memoryWrites: number;
  retryCount: number;
  errorCount: number;
  startedAt: number | undefined;
  updatedAt: number | undefined;
};

export function createInitialRendererState(): RendererState {
  return {
    workflowId: undefined,
    runId: undefined,
    status: undefined,
    currentTask: undefined,
    lastFailure: undefined,
    activeTasks: new Set(),
    completedTasks: [],
    recentEvents: [],
    recentLogs: [],
    taskHistory: [],
    timeline: [],
    artifactCount: 0,
    memoryWrites: 0,
    retryCount: 0,
    errorCount: 0,
    startedAt: undefined,
    updatedAt: undefined
  };
}

export function levelWeight(level: TaskLogLevel): number {
  switch (level) {
    case "debug":
      return 10;
    case "info":
      return 20;
    case "success":
      return 25;
    case "warn":
      return 30;
    case "error":
      return 40;
  }
}

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(11, 19);
}

function firstErrorFromMeta(meta: Record<string, unknown> | undefined): string | undefined {
  const errors = meta?.errors;
  if (!Array.isArray(errors)) {
    return undefined;
  }

  const first = errors.find((error) => typeof error === "string");
  return typeof first === "string" ? first : undefined;
}

export function failureReasonForEvent(event: ExecutionEvent): string | undefined {
  if (event.type === "task.failed") {
    if (typeof event.meta?.errorMessage === "string") {
      return event.meta.errorMessage;
    }

    return event.summary.startsWith("failed ") ? undefined : event.summary;
  }

  if (event.type === "workflow.failed") {
    if (typeof event.meta?.errorMessage === "string") {
      return event.meta.errorMessage;
    }

    return firstErrorFromMeta(event.meta) ?? (event.summary.endsWith(" failed") ? undefined : event.summary);
  }

  return undefined;
}

function failureSuffix(summary: string, reason: string | undefined): string {
  if (!reason || reason === summary) {
    return "";
  }

  return ` reason=${reason}`;
}

export function lineForEvent(event: ExecutionEvent): string {
  const prefix = `[${formatClock(event.timestamp)}]`;
  const failureReason = failureReasonForEvent(event);

  switch (event.type) {
    case "workflow.started":
      return `${prefix} workflow started ${event.summary}`;
    case "workflow.completed":
      return `${prefix} workflow completed ${event.summary}`;
    case "workflow.failed":
      return `${prefix} workflow failed ${event.summary}${failureSuffix(event.summary, failureReason)}`;
    case "task.queued":
    case "task.started":
    case "task.completed":
    case "task.retry_scheduled":
      return `${prefix} ${event.type} ${event.taskName} ${event.summary}`.trim();
    case "task.failed":
      return `${prefix} task.failed ${event.taskName} ${event.summary}${failureSuffix(event.summary, failureReason)}`.trim();
    case "branch.started":
    case "branch.completed":
    case "join.waiting":
    case "join.completed":
      return `${prefix} ${event.type} ${event.branchId} ${event.summary}`.trim();
    default:
      return `${prefix} ${event.type} ${event.summary}`.trim();
  }
}

export function lineForTaskLog(event: TaskLogEvent): string {
  const prefix = `[${formatClock(event.timestamp)}]`;
  const taskName = event.taskName ? ` ${event.taskName}` : "";
  return `${prefix} task ${event.level}${taskName} ${event.message}`;
}

export function jsonForTaskLog(event: TaskLogEvent): string {
  return JSON.stringify({
    kind: "taskLog",
    ...event
  });
}

export function jsonForEvent(event: ExecutionEvent): string {
  return JSON.stringify({
    kind: "event",
    ...event
  });
}

function clipMiddle(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) {
    return value;
  }

  if (maxWidth <= 3) {
    return value.slice(0, maxWidth);
  }

  return `${value.slice(0, maxWidth - 3)}...`;
}

function buildTaskHistoryText(event: ExecutionEvent & { taskName: string }): string {
  const failureReason = failureReasonForEvent(event);
  const phase =
    event.type === "task.retry_scheduled"
      ? "RETRY"
      : event.type === "task.queued"
        ? "QUEUED"
        : event.type === "task.started"
          ? "START"
          : event.type === "task.completed"
            ? "DONE"
            : "FAIL";

  const detail = failureReason ?? event.summary;
  return `${formatClock(event.timestamp)} ${clipMiddle(event.taskName, 18)} ${phase} ${detail}`;
}

function pushTaskHistory(
  state: RendererState,
  event: ExecutionEvent & { taskName: string },
  maxHistoryRows: number
): void {
  const phase =
    event.type === "task.retry_scheduled"
      ? "retry"
      : event.type === "task.queued"
        ? "queued"
        : event.type === "task.started"
          ? "started"
          : event.type === "task.completed"
            ? "completed"
            : "failed";

  state.taskHistory.push({
    id: `${event.type}:${event.taskName}:${event.timestamp}`,
    timestamp: event.timestamp,
    taskName: event.taskName,
    phase,
    summary: failureReasonForEvent(event) ?? event.summary,
    text: buildTaskHistoryText(event)
  });
  state.taskHistory = state.taskHistory.slice(-maxHistoryRows);
}

export function reduceExecutionEvent(
  state: RendererState,
  event: ExecutionEvent,
  maxRecentEvents: number,
  maxHistoryRows: number
): void {
  state.workflowId = event.workflowId;
  state.runId = event.runId;
  state.updatedAt = event.timestamp;
  state.recentEvents.push(lineForEvent(event));
  state.recentEvents = state.recentEvents.slice(-maxRecentEvents);

  switch (event.type) {
    case "workflow.started":
      state.status = "running";
      state.startedAt = event.timestamp;
      state.lastFailure = undefined;
      break;
    case "workflow.completed":
      state.status = event.status;
      state.lastFailure = undefined;
      state.activeTasks.clear();
      break;
    case "workflow.failed":
      state.status = event.status;
      state.lastFailure = failureReasonForEvent(event) ?? state.lastFailure;
      state.errorCount += 1;
      state.activeTasks.clear();
      break;
    case "task.queued":
      pushTaskHistory(state, event, maxHistoryRows);
      break;
    case "task.started":
      state.currentTask = event.taskName;
      state.activeTasks.add(event.taskName);
      pushTaskHistory(state, event, maxHistoryRows);
      break;
    case "task.completed":
      state.activeTasks.delete(event.taskName);
      state.completedTasks.push(event.taskName);
      state.completedTasks = state.completedTasks.slice(-5);
      pushTaskHistory(state, event, maxHistoryRows);
      break;
    case "task.failed":
      state.activeTasks.delete(event.taskName);
      state.lastFailure =
        failureReasonForEvent(event) !== undefined
          ? `${event.taskName}: ${failureReasonForEvent(event)}`
          : `${event.taskName} failed`;
      state.errorCount += 1;
      pushTaskHistory(state, event, maxHistoryRows);
      break;
    case "task.retry_scheduled":
      state.retryCount += 1;
      pushTaskHistory(state, event, maxHistoryRows);
      break;
    case "memory.put":
      state.memoryWrites += 1;
      break;
    case "artifact.created":
      state.artifactCount += 1;
      break;
    default:
      break;
  }
}

export function pushTaskLog(
  state: RendererState,
  event: TaskLogEvent,
  maxRecentLogs: number,
  maxTimelineRows: number
): void {
  const previous = state.recentLogs[state.recentLogs.length - 1];
  if (
    previous &&
    previous.taskName === event.taskName &&
    previous.level === event.level &&
    previous.message === event.message
  ) {
    state.recentLogs[state.recentLogs.length - 1] = event;
  } else {
    state.recentLogs.push(event);
    state.recentLogs = state.recentLogs.slice(-maxRecentLogs);
  }

  state.timeline.push({
    id: `task:${event.timestamp}:${event.taskName ?? "-"}:${event.level}:${event.message}`,
    timestamp: event.timestamp,
    level: event.level,
    source: "task",
    ...(event.taskName !== undefined ? { taskName: event.taskName } : {}),
    text: `${formatClock(event.timestamp)} [${event.level.toUpperCase()}] ${event.taskName ?? "-"} ${event.message}`
  });
  state.timeline = state.timeline.slice(-maxTimelineRows);
}

function clipUrl(url: string | undefined, maxWidth = 36): string {
  if (!url) {
    return "-";
  }

  try {
    const parsed = new URL(url);
    return clipMiddle(`${parsed.host}${parsed.pathname}`, maxWidth);
  } catch {
    return clipMiddle(url, maxWidth);
  }
}

export function buildDebugTimelineText(payload: Record<string, unknown>, timestamp: number): string {
  const phase = typeof payload.phase === "string" ? payload.phase : "debug";
  const badge =
    phase === "request" ? "REQ" : phase === "response" ? "RES" : phase === "error" ? "ERR" : "DBG";
  const provider = typeof payload.provider === "string" ? payload.provider : "provider";
  const method = typeof payload.method === "string" ? payload.method : "";
  const url = typeof payload.url === "string" ? payload.url : undefined;
  const status = typeof payload.status === "number" ? ` ${payload.status}` : "";
  const durationMs = typeof payload.durationMs === "number" ? ` ${payload.durationMs}ms` : "";
  const requestId = typeof payload.requestId === "string" && payload.requestId.length > 0 ? ` ${payload.requestId}` : "";
  const error = typeof payload.error === "string" ? ` ${payload.error}` : "";

  return `${formatClock(timestamp)} [${badge}] ${provider} ${method} ${clipUrl(url)}${status}${durationMs}${requestId}${error}`.trim();
}

export function pushDebugLogLine(
  state: RendererState,
  line: string,
  timestamp: number,
  maxTimelineRows: number
): void {
  const prefix = "[cycle:http] ";
  let text = `${formatClock(timestamp)} [DBG] ${line.trim()}`;

  if (line.startsWith(prefix)) {
    try {
      const payload = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
      text = buildDebugTimelineText(payload, timestamp);
    } catch {
      text = `${formatClock(timestamp)} [DBG] ${line.slice(prefix.length).trim()}`;
    }
  }

  state.timeline.push({
    id: `debug:${timestamp}:${state.timeline.length}`,
    timestamp,
    level: "debug",
    source: "debug",
    text
  });
  state.timeline = state.timeline.slice(-maxTimelineRows);
}

export function truncateText(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (value.length <= width) {
    return value;
  }

  if (width <= 1) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 1)}…`;
}
