import type { ExecutionEvent, TaskLogEvent } from "../types.js";
import {
  buildDebugTimelineText,
  buildMemoryTimelineText,
  clipMiddle,
  failureReasonForEvent,
  failureSourceLocationForEvent,
  failureStackForEvent,
  formatClock,
  formatDuration,
  formatTaskLogMeta,
  formatTimestampPrefix,
} from "./format.js";
import type { RendererState } from "./state.js";

function buildTaskHistoryText(
  event: ExecutionEvent & { taskName: string },
  durationMs?: number,
): string {
  const failureReason = failureReasonForEvent(event);
  const failureLocation = failureSourceLocationForEvent(event);
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

  const detail = `${failureReason ?? event.summary}${failureLocation ? ` @ ${failureLocation}` : ""}`;
  const durationSuffix =
    durationMs !== undefined && event.type !== "task.queued"
      ? ` ${formatDuration(durationMs)}`
      : "";
  return `${formatClock(event.timestamp)} ${clipMiddle(event.taskName, 18)} ${phase}${durationSuffix} ${detail}`;
}

export function pushTaskHistory(
  state: RendererState,
  event: ExecutionEvent & { taskName: string },
  maxHistoryRows: number,
  durationMs?: number,
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
    id: `${event.type}:${event.workflowId}:${event.taskName}:${event.timestamp}`,
    timestamp: event.timestamp,
    taskName: event.taskName,
    phase,
    summary: failureReasonForEvent(event) ?? event.summary,
    text: buildTaskHistoryText(event, durationMs),
  });
  state.taskHistory = state.taskHistory.slice(-maxHistoryRows);
}

export function pushTaskLog(
  state: RendererState,
  event: TaskLogEvent,
  maxRecentLogs: number,
  maxTimelineRows: number,
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
    text: `${formatTimestampPrefix(event.timestamp, event.level)} ${event.taskName ?? "-"} ${event.message}${formatTaskLogMeta(
      event.meta,
      {
        clipValues: true,
      },
    )}`,
  });
  state.timeline = state.timeline.slice(-maxTimelineRows);
}

export function pushMemoryTimelineEvent(
  state: RendererState,
  event: ExecutionEvent,
  maxTimelineRows: number,
): void {
  const taskName =
    "taskName" in event && typeof event.taskName === "string" ? event.taskName : undefined;
  state.timeline.push({
    id: `memory:${event.type}:${event.timestamp}:${state.timeline.length}`,
    timestamp: event.timestamp,
    level: event.type === "memory.expire" || event.type === "memory.warning" ? "warn" : "info",
    source: "memory",
    ...(taskName !== undefined ? { taskName } : {}),
    text: buildMemoryTimelineText(event),
  });
  state.timeline = state.timeline.slice(-maxTimelineRows);
}

export function pushDebugLogLine(
  state: RendererState,
  line: string,
  timestamp: number,
  maxTimelineRows: number,
): void {
  const prefix = "[cycle:http] ";
  let text = `${formatTimestampPrefix(timestamp, "debug")} [DBG] ${line.trim()}`;

  if (line.startsWith(prefix)) {
    try {
      const payload = JSON.parse(line.slice(prefix.length)) as Record<string, unknown>;
      text = buildDebugTimelineText(payload, timestamp);
    } catch {
      text = `${formatTimestampPrefix(timestamp, "debug")} [DBG] ${line.slice(prefix.length).trim()}`;
    }
  }

  state.timeline.push({
    id: `debug:${timestamp}:${state.timeline.length}`,
    timestamp,
    level: "debug",
    source: "debug",
    text,
  });
  state.timeline = state.timeline.slice(-maxTimelineRows);
}

export function pushFailureStackTimeline(
  state: RendererState,
  event: ExecutionEvent,
  maxTimelineRows: number,
): void {
  const sourceLocation = failureSourceLocationForEvent(event);
  if (sourceLocation) {
    const taskName =
      "taskName" in event && typeof event.taskName === "string" ? event.taskName : undefined;

    state.timeline.push({
      id: `source:${event.type}:${event.timestamp}`,
      timestamp: event.timestamp,
      level: "error",
      source: "task",
      ...(taskName !== undefined ? { taskName } : {}),
      text: `${formatTimestampPrefix(event.timestamp, "error")} [SOURCE] ${sourceLocation}`,
    });
  }

  const stackLines = failureStackForEvent(event);
  if (stackLines.length === 0) {
    state.timeline = state.timeline.slice(-maxTimelineRows);
    return;
  }

  const taskName =
    "taskName" in event && typeof event.taskName === "string" ? event.taskName : undefined;

  stackLines.forEach((stackLine, index) => {
    state.timeline.push({
      id: `stack:${event.type}:${event.timestamp}:${index}`,
      timestamp: event.timestamp,
      level: "error",
      source: "task",
      ...(taskName !== undefined ? { taskName } : {}),
      text: `${formatTimestampPrefix(event.timestamp, "error")} [STACK] ${stackLine}`,
    });
  });
  state.timeline = state.timeline.slice(-maxTimelineRows);
}
