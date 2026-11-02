import type { ExecutionEvent } from "../types.js";
import type {
  RendererState,
  WorkflowBranchState,
  WorkflowRenderState,
  WorkflowTaskState,
} from "./state.js";

export function getMetaString(event: ExecutionEvent, key: string): string | undefined {
  const value = event.meta?.[key];
  return typeof value === "string" ? value : undefined;
}

export function extractParentInfo(event: ExecutionEvent): {
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
    ...(branchId ? { branchId } : {}),
  };
}

function simplifyWorkflowId(workflowId: string): string {
  return workflowId.replace(/-[a-f0-9]{8}$/iu, "");
}

export function inferWorkflowName(summary: string, workflowId: string): string {
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

export function ensureWorkflowNode(
  state: RendererState,
  args: {
    workflowId: string;
    runId: string;
    summary?: string;
    parentWorkflowId?: string;
    parentRunId?: string;
    branchId?: string;
  },
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
    branches: new Map(),
  };

  state.workflows.set(args.workflowId, created);
  if (!args.parentWorkflowId && !state.workflowOrder.includes(args.workflowId)) {
    state.workflowOrder.push(args.workflowId);
  }

  return created;
}

export function ensureBranch(
  workflow: WorkflowRenderState,
  branchId: string,
  summary: string,
  timestamp: number,
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
    startedAt: timestamp,
  };
  workflow.branches.set(branchId, created);
  workflow.branchOrder.push(branchId);
  return created;
}

export function ensureTask(
  workflow: WorkflowRenderState,
  taskName: string,
  timestamp: number,
): WorkflowTaskState {
  const existing = workflow.tasks.get(taskName);
  if (existing) {
    existing.updatedAt = timestamp;
    return existing;
  }

  const created: WorkflowTaskState = {
    taskName,
    status: "queued",
    updatedAt: timestamp,
  };
  workflow.tasks.set(taskName, created);
  workflow.taskOrder.push(taskName);
  return created;
}

export function connectToParentWorkflow(
  state: RendererState,
  workflow: WorkflowRenderState,
  event: ExecutionEvent,
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
    runId: parentInfo.parentRunId ?? workflow.runId,
  });
  if (parentInfo.branchId) {
    const branch = ensureBranch(parent, parentInfo.branchId, parentInfo.branchId, event.timestamp);
    branch.childWorkflowId = workflow.workflowId;
    branch.childRunId = workflow.runId;
  }
}

export function getTaskDurationMs(task: WorkflowTaskState, now: number): number | undefined {
  if (task.startedAt === undefined) {
    return undefined;
  }

  const endedAt = task.endedAt ?? task.updatedAt ?? now;
  return Math.max(0, endedAt - task.startedAt);
}
