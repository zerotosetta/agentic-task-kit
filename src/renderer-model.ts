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
  source: "task" | "debug" | "memory";
  text: string;
  taskName?: string;
};

export type WorkflowTaskPhase = "queued" | "running" | "completed" | "failed" | "retry";

export type WorkflowTaskState = {
  taskName: string;
  status: WorkflowTaskPhase;
  queuedAt?: number;
  startedAt?: number;
  endedAt?: number;
  updatedAt: number;
};

export type WorkflowBranchState = {
  branchId: string;
  summary: string;
  status: "running" | "success" | "fail";
  startedAt: number;
  completedAt?: number;
  childWorkflowId?: string;
  childRunId?: string;
};

export type WorkflowRenderState = {
  workflowId: string;
  runId: string;
  name: string;
  summary: string;
  status: "running" | "success" | "fail";
  startedAt?: number;
  updatedAt?: number;
  completedAt?: number;
  parentWorkflowId?: string;
  parentRunId?: string;
  branchId?: string;
  taskOrder: string[];
  tasks: Map<string, WorkflowTaskState>;
  branchOrder: string[];
  branches: Map<string, WorkflowBranchState>;
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
  workflowOrder: string[];
  workflows: Map<string, WorkflowRenderState>;
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
    updatedAt: undefined,
    workflowOrder: [],
    workflows: new Map()
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

function getMetaString(
  event: ExecutionEvent,
  key: string
): string | undefined {
  const value = event.meta?.[key];
  return typeof value === "string" ? value : undefined;
}

function extractParentInfo(event: ExecutionEvent): {
  parentWorkflowId?: string;
  parentRunId?: string;
  branchId?: string;
} {
  const parentWorkflowId = getMetaString(event, "parentWorkflowId");
  const parentRunId = getMetaString(event, "parentRunId");
  const branchId = getMetaString(event, "branchId");

  return {
    ...(parentWorkflowId ? { parentWorkflowId } : {}),
    ...(parentRunId ? { parentRunId } : {}),
    ...(branchId ? { branchId } : {})
  };
}

function simplifyWorkflowId(workflowId: string): string {
  return workflowId.replace(/-[a-f0-9]{8}$/iu, "");
}

function inferWorkflowName(summary: string, workflowId: string): string {
  if (summary.includes(" start=")) {
    return summary.split(" start=")[0] ?? simplifyWorkflowId(workflowId);
  }

  if (summary.endsWith(" completed")) {
    return summary.slice(0, -" completed".length);
  }

  if (summary.endsWith(" failed")) {
    return summary.slice(0, -" failed".length);
  }

  return simplifyWorkflowId(workflowId);
}

function ensureWorkflowNode(
  state: RendererState,
  args: {
    workflowId: string;
    runId: string;
    summary?: string;
    parentWorkflowId?: string;
    parentRunId?: string;
    branchId?: string;
  }
): WorkflowRenderState {
  const existing = state.workflows.get(args.workflowId);
  if (existing) {
    if (args.summary) {
      existing.summary = args.summary;
      existing.name = inferWorkflowName(args.summary, existing.workflowId);
    }
    if (args.parentWorkflowId) {
      existing.parentWorkflowId = args.parentWorkflowId;
    }
    if (args.parentRunId) {
      existing.parentRunId = args.parentRunId;
    }
    if (args.branchId) {
      existing.branchId = args.branchId;
    }
    return existing;
  }

  const created: WorkflowRenderState = {
    workflowId: args.workflowId,
    runId: args.runId,
    name: inferWorkflowName(args.summary ?? args.workflowId, args.workflowId),
    summary: args.summary ?? "",
    status: "running",
    ...(args.parentWorkflowId ? { parentWorkflowId: args.parentWorkflowId } : {}),
    ...(args.parentRunId ? { parentRunId: args.parentRunId } : {}),
    ...(args.branchId ? { branchId: args.branchId } : {}),
    taskOrder: [],
    tasks: new Map(),
    branchOrder: [],
    branches: new Map()
  };

  state.workflows.set(args.workflowId, created);
  if (!args.parentWorkflowId && !state.workflowOrder.includes(args.workflowId)) {
    state.workflowOrder.push(args.workflowId);
  }

  return created;
}

function ensureBranch(
  workflow: WorkflowRenderState,
  branchId: string,
  summary: string,
  timestamp: number
): WorkflowBranchState {
  const existing = workflow.branches.get(branchId);
  if (existing) {
    existing.summary = summary || existing.summary;
    return existing;
  }

  const created: WorkflowBranchState = {
    branchId,
    summary,
    status: "running",
    startedAt: timestamp
  };
  workflow.branches.set(branchId, created);
  workflow.branchOrder.push(branchId);
  return created;
}

function ensureTask(
  workflow: WorkflowRenderState,
  taskName: string,
  timestamp: number
): WorkflowTaskState {
  const existing = workflow.tasks.get(taskName);
  if (existing) {
    existing.updatedAt = timestamp;
    return existing;
  }

  const created: WorkflowTaskState = {
    taskName,
    status: "queued",
    updatedAt: timestamp
  };
  workflow.tasks.set(taskName, created);
  workflow.taskOrder.push(taskName);
  return created;
}

function connectToParentWorkflow(
  state: RendererState,
  workflow: WorkflowRenderState,
  event: ExecutionEvent
): void {
  const parentInfo = extractParentInfo(event);
  if (!parentInfo.parentWorkflowId) {
    return;
  }

  workflow.parentWorkflowId = parentInfo.parentWorkflowId;
  if (parentInfo.parentRunId) {
    workflow.parentRunId = parentInfo.parentRunId;
  }
  if (parentInfo.branchId) {
    workflow.branchId = parentInfo.branchId;
  }

  const parent = ensureWorkflowNode(state, {
    workflowId: parentInfo.parentWorkflowId,
    runId: parentInfo.parentRunId ?? workflow.runId
  });
  if (parentInfo.branchId) {
    const branch = ensureBranch(
      parent,
      parentInfo.branchId,
      parentInfo.branchId,
      event.timestamp
    );
    branch.childWorkflowId = workflow.workflowId;
    branch.childRunId = workflow.runId;
  }
}

export function getTaskDurationMs(
  task: WorkflowTaskState,
  now: number
): number | undefined {
  if (task.startedAt === undefined) {
    return undefined;
  }

  const endedAt = task.endedAt ?? task.updatedAt ?? now;
  return Math.max(0, endedAt - task.startedAt);
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
  return `${prefix} task ${event.level}${taskName} ${event.message}${formatTaskLogMeta(event.meta)}`;
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

function buildTaskHistoryText(
  event: ExecutionEvent & { taskName: string },
  durationMs?: number
): string {
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
  const durationSuffix =
    durationMs !== undefined && event.type !== "task.queued"
      ? ` ${formatDuration(durationMs)}`
      : "";
  return `${formatClock(event.timestamp)} ${clipMiddle(event.taskName, 18)} ${phase}${durationSuffix} ${detail}`;
}

function pushTaskHistory(
  state: RendererState,
  event: ExecutionEvent & { taskName: string },
  maxHistoryRows: number,
  durationMs?: number
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
    text: buildTaskHistoryText(event, durationMs)
  });
  state.taskHistory = state.taskHistory.slice(-maxHistoryRows);
}

function updateTaskStateFromEvent(
  state: RendererState,
  event: Extract<ExecutionEvent, { taskName: string }>
): WorkflowTaskState {
  const workflow = ensureWorkflowNode(state, {
    workflowId: event.workflowId,
    runId: event.runId
  });
  connectToParentWorkflow(state, workflow, event);
  const task = ensureTask(workflow, event.taskName, event.timestamp);

  switch (event.type) {
    case "task.queued":
      task.status = "queued";
      task.queuedAt ??= event.timestamp;
      break;
    case "task.started":
      task.status = "running";
      task.startedAt ??= event.timestamp;
      break;
    case "task.completed":
      task.status = "completed";
      task.startedAt ??= task.queuedAt ?? event.timestamp;
      task.endedAt = event.timestamp;
      break;
    case "task.failed":
      task.status = "failed";
      task.startedAt ??= task.queuedAt ?? event.timestamp;
      task.endedAt = event.timestamp;
      break;
    case "task.retry_scheduled":
      task.status = "retry";
      task.startedAt ??= task.queuedAt ?? event.timestamp;
      task.endedAt = event.timestamp;
      break;
  }

  task.updatedAt = event.timestamp;
  workflow.updatedAt = event.timestamp;
  return task;
}

function maybeSetRootWorkflow(state: RendererState, event: ExecutionEvent): void {
  if (state.workflowId !== undefined) {
    return;
  }

  state.workflowId = event.workflowId;
  state.runId = event.runId;
}

function maybePromoteTopLevelWorkflow(state: RendererState, event: ExecutionEvent): void {
  const parentInfo = extractParentInfo(event);
  if (!parentInfo.parentWorkflowId) {
    state.workflowId = event.workflowId;
    state.runId = event.runId;
  } else {
    maybeSetRootWorkflow(state, event);
  }
}

export function reduceExecutionEvent(
  state: RendererState,
  event: ExecutionEvent,
  maxRecentEvents: number,
  maxHistoryRows: number,
  maxTimelineRows = 480
): void {
  maybeSetRootWorkflow(state, event);
  state.updatedAt = event.timestamp;
  state.recentEvents.push(lineForEvent(event));
  state.recentEvents = state.recentEvents.slice(-maxRecentEvents);

  switch (event.type) {
    case "workflow.started": {
      maybePromoteTopLevelWorkflow(state, event);
      const workflow = ensureWorkflowNode(state, {
        workflowId: event.workflowId,
        runId: event.runId,
        summary: event.summary,
        ...extractParentInfo(event)
      });
      workflow.summary = event.summary;
      workflow.name = inferWorkflowName(event.summary, event.workflowId);
      workflow.status = "running";
      workflow.startedAt ??= event.timestamp;
      workflow.updatedAt = event.timestamp;
      connectToParentWorkflow(state, workflow, event);

      state.status = "running";
      state.startedAt ??= event.timestamp;
      state.lastFailure = undefined;
      break;
    }
    case "workflow.completed": {
      maybePromoteTopLevelWorkflow(state, event);
      const workflow = ensureWorkflowNode(state, {
        workflowId: event.workflowId,
        runId: event.runId,
        summary: event.summary,
        ...extractParentInfo(event)
      });
      workflow.summary = event.summary;
      workflow.name = inferWorkflowName(event.summary, event.workflowId);
      workflow.status = "success";
      workflow.completedAt = event.timestamp;
      workflow.updatedAt = event.timestamp;
      connectToParentWorkflow(state, workflow, event);

      if (!workflow.parentWorkflowId) {
        state.status = event.status;
        state.lastFailure = undefined;
      }
      state.activeTasks.clear();
      break;
    }
    case "workflow.failed": {
      maybePromoteTopLevelWorkflow(state, event);
      const workflow = ensureWorkflowNode(state, {
        workflowId: event.workflowId,
        runId: event.runId,
        summary: event.summary,
        ...extractParentInfo(event)
      });
      workflow.summary = event.summary;
      workflow.name = inferWorkflowName(event.summary, event.workflowId);
      workflow.status = "fail";
      workflow.completedAt = event.timestamp;
      workflow.updatedAt = event.timestamp;
      connectToParentWorkflow(state, workflow, event);

      if (!workflow.parentWorkflowId) {
        state.status = event.status;
        state.lastFailure = failureReasonForEvent(event) ?? state.lastFailure;
        state.errorCount += 1;
      }
      state.activeTasks.clear();
      break;
    }
    case "branch.started": {
      const workflow = ensureWorkflowNode(state, {
        workflowId: event.workflowId,
        runId: event.runId
      });
      const summary =
        getMetaString(event, "subWorkflowKey") ??
        event.summary ??
        event.branchId;
      const branch = ensureBranch(workflow, event.branchId, summary, event.timestamp);
      branch.status = "running";
      branch.startedAt = event.timestamp;
      workflow.updatedAt = event.timestamp;
      break;
    }
    case "branch.completed": {
      const workflow = ensureWorkflowNode(state, {
        workflowId: event.workflowId,
        runId: event.runId
      });
      const branch = ensureBranch(workflow, event.branchId, event.summary, event.timestamp);
      branch.summary = event.summary;
      branch.status = event.status === "fail" ? "fail" : "success";
      branch.completedAt = event.timestamp;
      const childWorkflowId = getMetaString(event, "childWorkflowId");
      const childRunId = getMetaString(event, "childRunId");
      if (childWorkflowId) {
        branch.childWorkflowId = childWorkflowId;
      }
      if (childRunId) {
        branch.childRunId = childRunId;
      }
      workflow.updatedAt = event.timestamp;
      break;
    }
    case "task.queued": {
      const task = updateTaskStateFromEvent(state, event);
      pushTaskHistory(state, event, maxHistoryRows, getTaskDurationMs(task, event.timestamp));
      break;
    }
    case "task.started": {
      const workflow = ensureWorkflowNode(state, {
        workflowId: event.workflowId,
        runId: event.runId
      });
      state.currentTask = workflow.parentWorkflowId
        ? `${workflow.name}/${event.taskName}`
        : event.taskName;
      state.activeTasks.add(state.currentTask);
      const task = updateTaskStateFromEvent(state, event);
      pushTaskHistory(state, event, maxHistoryRows, getTaskDurationMs(task, event.timestamp));
      break;
    }
    case "task.completed": {
      const workflow = ensureWorkflowNode(state, {
        workflowId: event.workflowId,
        runId: event.runId
      });
      const activeLabel = workflow.parentWorkflowId
        ? `${workflow.name}/${event.taskName}`
        : event.taskName;
      state.activeTasks.delete(activeLabel);
      state.completedTasks.push(activeLabel);
      state.completedTasks = state.completedTasks.slice(-5);
      const task = updateTaskStateFromEvent(state, event);
      pushTaskHistory(state, event, maxHistoryRows, getTaskDurationMs(task, event.timestamp));
      break;
    }
    case "task.failed": {
      const workflow = ensureWorkflowNode(state, {
        workflowId: event.workflowId,
        runId: event.runId
      });
      const activeLabel = workflow.parentWorkflowId
        ? `${workflow.name}/${event.taskName}`
        : event.taskName;
      state.activeTasks.delete(activeLabel);
      state.lastFailure =
        failureReasonForEvent(event) !== undefined
          ? `${event.taskName}: ${failureReasonForEvent(event)}`
          : `${event.taskName} failed`;
      state.errorCount += 1;
      const task = updateTaskStateFromEvent(state, event);
      pushTaskHistory(state, event, maxHistoryRows, getTaskDurationMs(task, event.timestamp));
      break;
    }
    case "task.retry_scheduled": {
      const task = updateTaskStateFromEvent(state, event);
      state.retryCount += 1;
      pushTaskHistory(state, event, maxHistoryRows, getTaskDurationMs(task, event.timestamp));
      break;
    }
    case "memory.before_step":
    case "memory.after_step":
    case "retrieval.performed":
    case "memory.write":
    case "memory.warning":
    case "memory.merge":
    case "memory.archive":
    case "memory.expire":
    case "memory.compress":
      state.memoryWrites += 1;
      pushMemoryTimelineEvent(state, event, maxTimelineRows);
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
    text: `${formatClock(event.timestamp)} [${event.level.toUpperCase()}] ${event.taskName ?? "-"} ${event.message}${formatTaskLogMeta(event.meta)}`
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

function renderTaskLogMetaValue(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(clipMiddle(value, 96));
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  if (Array.isArray(value)) {
    return JSON.stringify(clipMiddle(value.map((entry) => stringifyMetaValue(entry)).join(","), 96));
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  try {
    return JSON.stringify(clipMiddle(JSON.stringify(value), 96));
  } catch {
    return JSON.stringify(clipMiddle(String(value), 96));
  }
}

function formatTaskLogMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta) {
    return "";
  }

  const rendered = Object.entries(meta)
    .map(([key, value]) => {
      const renderedValue = renderTaskLogMetaValue(value);
      return renderedValue ? `${key}=${renderedValue}` : "";
    })
    .filter(Boolean)
    .slice(0, 8);

  return rendered.length > 0 ? ` ${rendered.join(" ")}` : "";
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
  const requestId =
    typeof payload.requestId === "string" && payload.requestId.length > 0
      ? ` ${payload.requestId}`
      : "";
  const error = typeof payload.error === "string" ? ` ${payload.error}` : "";

  return `${formatClock(timestamp)} [${badge}] ${provider} ${method} ${clipUrl(url)}${status}${durationMs}${requestId}${error}`.trim();
}

export function buildMemoryTimelineText(event: ExecutionEvent): string {
  const prefix = `${formatClock(event.timestamp)} [MEM]`;

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

export function pushMemoryTimelineEvent(
  state: RendererState,
  event: ExecutionEvent,
  maxTimelineRows: number
): void {
  const taskName =
    "taskName" in event && typeof event.taskName === "string"
      ? event.taskName
      : undefined;
  state.timeline.push({
    id: `memory:${event.type}:${event.timestamp}:${state.timeline.length}`,
    timestamp: event.timestamp,
    level:
      event.type === "memory.expire" || event.type === "memory.warning" ? "warn" : "info",
    source: "memory",
    ...(taskName !== undefined ? { taskName } : {}),
    text: buildMemoryTimelineText(event)
  });
  state.timeline = state.timeline.slice(-maxTimelineRows);
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

  if (width <= 3) {
    return value.slice(0, width);
  }

  return `${value.slice(0, width - 3)}...`;
}
