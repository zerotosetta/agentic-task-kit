import type { ExecutionEvent } from "../types.js";
import {
  failureReasonForEvent,
  failureSourceLocationForEvent,
  failureStackForEvent,
  lineForEvent,
} from "./format.js";
import type { RendererState, WorkflowTaskState } from "./state.js";
import { pushFailureStackTimeline, pushMemoryTimelineEvent, pushTaskHistory } from "./timeline.js";
import {
  connectToParentWorkflow,
  ensureBranch,
  ensureTask,
  ensureWorkflowNode,
  extractParentInfo,
  getMetaString,
  getTaskDurationMs,
  inferWorkflowName,
} from "./workflow-state.js";

function updateTaskStateFromEvent(
  state: RendererState,
  event: Extract<ExecutionEvent, { taskName: string }>,
): WorkflowTaskState {
  const workflow = ensureWorkflowNode(state, {
    workflowId: event.workflowId,
    runId: event.runId,
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
  maxTimelineRows = 480,
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
        ...extractParentInfo(event),
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
      state.lastFailureStack = [];
      break;
    }
    case "workflow.completed": {
      maybePromoteTopLevelWorkflow(state, event);
      const workflow = ensureWorkflowNode(state, {
        workflowId: event.workflowId,
        runId: event.runId,
        summary: event.summary,
        ...extractParentInfo(event),
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
        state.lastFailureStack = [];
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
        ...extractParentInfo(event),
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
        state.lastFailureStack = failureStackForEvent(event);
        state.errorCount += 1;
      }
      pushFailureStackTimeline(state, event, maxTimelineRows);
      state.activeTasks.clear();
      break;
    }
    case "branch.started": {
      const workflow = ensureWorkflowNode(state, {
        workflowId: event.workflowId,
        runId: event.runId,
      });
      const summary = getMetaString(event, "subWorkflowKey") ?? event.summary ?? event.branchId;
      const branch = ensureBranch(workflow, event.branchId, summary, event.timestamp);
      branch.status = "running";
      branch.startedAt = event.timestamp;
      workflow.updatedAt = event.timestamp;
      break;
    }
    case "branch.completed": {
      const workflow = ensureWorkflowNode(state, {
        workflowId: event.workflowId,
        runId: event.runId,
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
        runId: event.runId,
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
        runId: event.runId,
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
        runId: event.runId,
      });
      const activeLabel = workflow.parentWorkflowId
        ? `${workflow.name}/${event.taskName}`
        : event.taskName;
      state.activeTasks.delete(activeLabel);
      state.lastFailure =
        failureReasonForEvent(event) !== undefined
          ? `${event.taskName}: ${failureReasonForEvent(event)}${
              failureSourceLocationForEvent(event)
                ? ` @ ${failureSourceLocationForEvent(event)}`
                : ""
            }`
          : `${event.taskName} failed`;
      state.lastFailureStack = failureStackForEvent(event);
      state.errorCount += 1;
      const task = updateTaskStateFromEvent(state, event);
      pushTaskHistory(state, event, maxHistoryRows, getTaskDurationMs(task, event.timestamp));
      pushFailureStackTimeline(state, event, maxTimelineRows);
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
