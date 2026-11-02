import type { TaskLogEvent, TaskLogLevel } from "../types.js";

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
  lastFailureStack: string[];
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
    lastFailureStack: [],
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
    workflows: new Map(),
  };
}
