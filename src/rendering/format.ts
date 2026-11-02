import {
  extractSourceLocationFromErrorDetails,
  formatErrorSourceLocation,
} from "../error-location.js";
import type { ExecutionEvent, TaskLogEvent, TaskLogLevel } from "../types.js";

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

function formatLevelBadge(level: TaskLogLevel): string {
  return `[${level.toUpperCase()}]`;
}

export function formatTimestampPrefix(timestamp: number, level: TaskLogLevel): string {
  return `[${formatClock(timestamp)}] ${formatLevelBadge(level)}`;
}

function taskLogLevelForEvent(event: ExecutionEvent): TaskLogLevel {
  switch (event.type) {
    case "task.failed":
    case "workflow.failed":
      return "error";
    case "task.completed":
    case "workflow.completed":
    case "branch.completed":
    case "join.completed":
      return "success";
    case "memory.warning":
    case "memory.expire":
      return "warn";
    default:
      return "info";
  }
}

export function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined || durationMs < 0) {
    return "-";
  }

  if (durationMs < 1_000) {
    return `${durationMs}ms`;
  }

  if (durationMs < 10_000) {
    return `${(durationMs / 1_000).toFixed(1)}s`;
  }

  if (durationMs < 60_000) {
    return `${Math.round(durationMs / 1_000)}s`;
  }

  const minutes = Math.floor(durationMs / 60_000);
  const seconds = Math.round((durationMs % 60_000) / 1_000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
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

    return (
      firstErrorFromMeta(event.meta) ??
      (event.summary.endsWith(" failed") ? undefined : event.summary)
    );
  }

  return undefined;
}

export function failureStackForEvent(event: ExecutionEvent): string[] {
  const stack =
    event.meta?.errorDetails &&
    typeof event.meta.errorDetails === "object" &&
    !Array.isArray(event.meta.errorDetails) &&
    "stack" in event.meta.errorDetails
      ? (event.meta.errorDetails as { stack?: unknown }).stack
      : undefined;

  if (typeof stack !== "string") {
    return [];
  }

  return stack
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

export function failureSourceLocationForEvent(event: ExecutionEvent): string | undefined {
  const sourceLocation = extractSourceLocationFromErrorDetails(event.meta?.errorDetails);
  if (sourceLocation) {
    return formatErrorSourceLocation(sourceLocation);
  }

  const metaLocation = extractSourceLocationFromErrorDetails({
    sourceLocation: event.meta?.sourceLocation,
  });
  return metaLocation ? formatErrorSourceLocation(metaLocation) : undefined;
}

function failureSuffix(summary: string, reason: string | undefined): string {
  if (!reason || reason === summary) {
    return "";
  }

  return ` reason=${reason}`;
}

function locationSuffix(location: string | undefined): string {
  return location ? ` at=${location}` : "";
}

export function lineForEvent(event: ExecutionEvent): string {
  const prefix = formatTimestampPrefix(event.timestamp, taskLogLevelForEvent(event));
  const failureReason = failureReasonForEvent(event);
  const failureLocation = failureSourceLocationForEvent(event);

  switch (event.type) {
    case "workflow.started":
      return `${prefix} workflow started ${event.summary}`;
    case "workflow.completed":
      return `${prefix} workflow completed ${event.summary}`;
    case "workflow.failed":
      return `${prefix} workflow failed ${event.summary}${failureSuffix(event.summary, failureReason)}${locationSuffix(failureLocation)}`;
    case "task.queued":
    case "task.started":
    case "task.completed":
    case "task.retry_scheduled":
      return `${prefix} ${event.type} ${event.taskName} ${event.summary}`.trim();
    case "task.failed":
      return `${prefix} task.failed ${event.taskName} ${event.summary}${failureSuffix(event.summary, failureReason)}${locationSuffix(failureLocation)}`.trim();
    case "branch.started":
    case "branch.completed":
    case "join.waiting":
    case "join.completed":
      return `${prefix} ${event.type} ${event.branchId} ${event.summary}`.trim();
    default:
      return `${prefix} ${event.type} ${event.summary}`.trim();
  }
}

export function linesForEvent(event: ExecutionEvent): string[] {
  const lines = [lineForEvent(event)];
  const failureLocation = failureSourceLocationForEvent(event);
  if (failureLocation) {
    lines.push(`${formatTimestampPrefix(event.timestamp, "error")} source ${failureLocation}`);
  }
  const stackLines = failureStackForEvent(event);
  if (stackLines.length === 0) {
    return lines;
  }

  const prefix = `${formatTimestampPrefix(event.timestamp, "error")} stack `;
  for (const stackLine of stackLines) {
    lines.push(`${prefix}${stackLine}`);
  }

  return lines;
}

export function lineForTaskLog(event: TaskLogEvent): string {
  const prefix = formatTimestampPrefix(event.timestamp, event.level);
  const taskName = event.taskName ? ` ${event.taskName}` : "";
  return `${prefix} task${taskName} ${event.message}${formatTaskLogMeta(event.meta, {
    clipValues: false,
  })}`;
}

export function jsonForTaskLog(event: TaskLogEvent): string {
  return JSON.stringify({
    kind: "taskLog",
    ...event,
  });
}

export function jsonForEvent(event: ExecutionEvent): string {
  return JSON.stringify({
    kind: "event",
    ...event,
  });
}

export function clipMiddle(value: string, maxWidth: number): string {
  if (value.length <= maxWidth) {
    return value;
  }

  if (maxWidth <= 3) {
    return value.slice(0, maxWidth);
  }

  return `${value.slice(0, maxWidth - 3)}...`;
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

function stringifyMetaValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => stringifyMetaValue(entry))
      .filter(Boolean)
      .join(",");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function renderTaskLogMetaValue(
  value: unknown,
  options: {
    clipValues: boolean;
  },
): string {
  if (typeof value === "string") {
    return JSON.stringify(options.clipValues ? clipMiddle(value, 96) : value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    const serialized = value.map((entry) => stringifyMetaValue(entry)).join(",");
    return JSON.stringify(options.clipValues ? clipMiddle(serialized, 96) : serialized);
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  try {
    const serialized = JSON.stringify(value);
    return JSON.stringify(options.clipValues ? clipMiddle(serialized, 96) : serialized);
  } catch {
    const serialized = String(value);
    return JSON.stringify(options.clipValues ? clipMiddle(serialized, 96) : serialized);
  }
}

export function formatTaskLogMeta(
  meta: Record<string, unknown> | undefined,
  options: {
    clipValues: boolean;
  },
): string {
  if (!meta) {
    return "";
  }

  const rendered = Object.entries(meta)
    .map(([key, value]) => {
      const renderedValue = renderTaskLogMetaValue(value, options);
      return renderedValue ? `${key}=${renderedValue}` : "";
    })
    .filter(Boolean)
    .slice(0, 8);

  return rendered.length > 0 ? ` ${rendered.join(" ")}` : "";
}

export function buildDebugTimelineText(
  payload: Record<string, unknown>,
  timestamp: number,
): string {
  const phase = typeof payload.phase === "string" ? payload.phase : "debug";
  const badge =
    phase === "request" ? "REQ" : phase === "response" ? "RES" : phase === "error" ? "ERR" : "DBG";
  const provider = typeof payload.provider === "string" ? payload.provider : "provider";
  const method = typeof payload.method === "string" ? payload.method : "";
  const url = typeof payload.url === "string" ? payload.url : undefined;
  const status = typeof payload.status === "number" ? ` ${payload.status}` : "";
  const durationMs = typeof payload.durationMs === "number" ? ` ${payload.durationMs}ms` : "";
  const requestId =
    typeof payload.requestId === "string" && payload.requestId.length > 0
      ? ` ${payload.requestId}`
      : "";
  const error = typeof payload.error === "string" ? ` ${payload.error}` : "";

  return `${formatTimestampPrefix(timestamp, "debug")} [${badge}] ${provider} ${method} ${clipUrl(url)}${status}${durationMs}${requestId}${error}`.trim();
}

export function buildMemoryTimelineText(event: ExecutionEvent): string {
  const level = event.type === "memory.warning" || event.type === "memory.expire" ? "warn" : "info";
  const prefix = `${formatTimestampPrefix(event.timestamp, level)} [MEM]`;

  switch (event.type) {
    case "memory.before_step": {
      const taskName = typeof event.meta?.taskName === "string" ? event.meta.taskName : "-";
      const taskType = typeof event.meta?.taskType === "string" ? event.meta.taskType : "-";
      const phase = typeof event.meta?.phase === "string" ? event.meta.phase : "-";
      const shards = stringifyMetaValue(event.meta?.routedShards) || "-";
      const usedTokens = typeof event.meta?.usedTokens === "number" ? event.meta.usedTokens : "-";
      return `${prefix} before ${taskName} type=${taskType} phase=${phase} shards=${shards} tokens=${usedTokens}`;
    }
    case "retrieval.performed": {
      const shards = stringifyMetaValue(event.meta?.routedShards) || "-";
      const hitCount = typeof event.meta?.hitCount === "number" ? event.meta.hitCount : "-";
      const usedTokens = typeof event.meta?.usedTokens === "number" ? event.meta.usedTokens : "-";
      return `${prefix} retrieve shards=${shards} hits=${hitCount} tokens=${usedTokens}`;
    }
    case "memory.after_step": {
      const taskName = typeof event.meta?.taskName === "string" ? event.meta.taskName : "-";
      const taskRecordAction =
        typeof event.meta?.taskRecordAction === "string" ? event.meta.taskRecordAction : "-";
      const workflowRecordAction =
        typeof event.meta?.workflowRecordAction === "string"
          ? event.meta.workflowRecordAction
          : "-";
      const compressedIds = stringifyMetaValue(event.meta?.compressedIds) || "-";
      return `${prefix} after ${taskName} task=${taskRecordAction} workflow=${workflowRecordAction} compressed=${compressedIds}`;
    }
    case "memory.write":
    case "memory.warning":
    case "memory.merge":
    case "memory.compress":
    case "memory.archive":
    case "memory.expire": {
      const code = typeof event.meta?.code === "string" ? ` code=${event.meta.code}` : "";
      const recordId = typeof event.meta?.recordId === "string" ? event.meta.recordId : "";
      const targetId =
        typeof event.meta?.targetId === "string" ? ` target=${event.meta.targetId}` : "";
      const reason = typeof event.meta?.reason === "string" ? ` ${event.meta.reason}` : "";
      const similarityScore =
        typeof event.meta?.similarityScore === "number"
          ? ` similarity=${event.meta.similarityScore.toFixed(2)}`
          : "";
      const ids = [
        stringifyMetaValue(event.meta?.archivedIds),
        stringifyMetaValue(event.meta?.expiredIds),
        stringifyMetaValue(event.meta?.deletedIds),
        stringifyMetaValue(event.meta?.compressedIds),
      ]
        .filter(Boolean)
        .join("|");
      return `${prefix} ${event.type.replace("memory.", "")} ${recordId}${targetId}${
        ids ? ` ids=${ids}` : ""
      }${code}${similarityScore}${reason}`.trim();
    }
    default:
      return `${prefix} ${event.summary}`;
  }
}

export function truncateText(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (value.length <= width) {
    return value;
  }

  if (width <= 3) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 3)}...`;
}
