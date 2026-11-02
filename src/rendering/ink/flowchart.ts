import {
  formatDuration,
  getTaskDurationMs,
  type RendererState,
  type WorkflowRenderState,
  type WorkflowTaskState,
} from "../../renderer-model.js";
import { padLine } from "./layout.js";
import { TASK_BOX_INNER_WIDTH } from "./model.js";

function taskStatusLabel(task: WorkflowTaskState): string {
  switch (task.status) {
    case "queued":
      return "QUE";
    case "running":
      return "RUN";
    case "completed":
      return "DONE";
    case "failed":
      return "FAIL";
    case "retry":
      return "RETRY";
  }
}

function workflowStatusLabel(status: WorkflowRenderState["status"]): string {
  switch (status) {
    case "success":
      return "SUCCESS";
    case "fail":
      return "FAIL";
    default:
      return "RUNNING";
  }
}

function buildTaskBox(task: WorkflowTaskState, now: number): string[] {
  const duration = formatDuration(getTaskDurationMs(task, now));
  const top = `┌${"─".repeat(TASK_BOX_INNER_WIDTH)}┐`;
  const name = `│${padLine(task.taskName, TASK_BOX_INNER_WIDTH)}│`;
  const detail = `│${padLine(`${taskStatusLabel(task)} ${duration}`, TASK_BOX_INNER_WIDTH)}│`;
  const bottom = `└${"─".repeat(TASK_BOX_INNER_WIDTH)}┘`;
  return [top, name, detail, bottom];
}

function groupTasksForWidth(
  tasks: WorkflowTaskState[],
  width: number,
  indent: number,
): WorkflowTaskState[][] {
  const groups: WorkflowTaskState[][] = [];
  const boxWidth = TASK_BOX_INNER_WIDTH + 2;
  const gapWidth = 3;
  const availableWidth = Math.max(boxWidth, width - indent);
  let current: WorkflowTaskState[] = [];
  let consumed = 0;

  for (const task of tasks) {
    const nextWidth = current.length === 0 ? boxWidth : boxWidth + gapWidth;
    if (current.length > 0 && consumed + nextWidth > availableWidth) {
      groups.push(current);
      current = [task];
      consumed = boxWidth;
      continue;
    }

    current.push(task);
    consumed += nextWidth;
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

function renderTaskGroups(
  tasks: WorkflowTaskState[],
  width: number,
  indent: number,
  now: number,
): string[] {
  if (tasks.length === 0) {
    const idleTask: WorkflowTaskState = {
      taskName: "waiting",
      status: "queued",
      updatedAt: now,
    };
    tasks = [idleTask];
  }

  const groups = groupTasksForWidth(tasks, width, indent);
  const lines: string[] = [];
  const prefix = " ".repeat(indent);
  const connector = ["   ", "   ", "──▶", "   "];

  for (const group of groups) {
    const rendered = group.map((task) => buildTaskBox(task, now));
    for (let row = 0; row < 4; row += 1) {
      let line = prefix;
      for (let index = 0; index < rendered.length; index += 1) {
        line += rendered[index]?.[row] ?? "";
        if (index < rendered.length - 1) {
          line += connector[row] ?? "   ";
        }
      }
      lines.push(padLine(line, width));
    }
  }

  return lines;
}

function workflowDurationMs(workflow: WorkflowRenderState, now: number): number | undefined {
  if (workflow.startedAt === undefined) {
    return undefined;
  }

  const endedAt = workflow.completedAt ?? workflow.updatedAt ?? now;
  return Math.max(0, endedAt - workflow.startedAt);
}

function renderWorkflowBranchLines(
  state: RendererState,
  workflowId: string,
  width: number,
  depth: number,
  branchLabel?: string,
  visited = new Set<string>(),
): string[] {
  if (visited.has(workflowId)) {
    const indent = depth * 4;
    const prefix = " ".repeat(indent);
    const lines: string[] = [];
    if (branchLabel) {
      lines.push(padLine(`${prefix}${branchLabel}`, width));
    }
    lines.push(padLine(`${prefix}(cycle detected: ${workflowId})`, width));
    return lines;
  }

  const workflow = state.workflows.get(workflowId);
  if (!workflow) {
    return [];
  }

  const now = state.updatedAt ?? Date.now();
  const indent = depth * 4;
  const lines: string[] = [];
  const headerPrefix = " ".repeat(indent);
  const nextVisited = new Set(visited);
  nextVisited.add(workflowId);
  const workflowLabel = `${workflow.name} [${workflowStatusLabel(workflow.status)} ${formatDuration(workflowDurationMs(workflow, now))}]`;

  if (branchLabel) {
    lines.push(padLine(`${headerPrefix}${branchLabel}`, width));
  }

  lines.push(padLine(`${headerPrefix}${workflowLabel}`, width));

  const orderedTasks = workflow.taskOrder
    .map((taskName) => workflow.tasks.get(taskName))
    .filter((task): task is WorkflowTaskState => task !== undefined);
  lines.push(...renderTaskGroups(orderedTasks, width, indent, now));

  for (const branchId of workflow.branchOrder) {
    const branch = workflow.branches.get(branchId);
    if (!branch) {
      continue;
    }

    const branchSummary = `${headerPrefix}└─ ${branch.branchId} [${branch.status.toUpperCase()}] ${branch.summary}`;
    if (branch.childWorkflowId) {
      lines.push(
        ...renderWorkflowBranchLines(
          state,
          branch.childWorkflowId,
          width,
          depth + 1,
          branchSummary,
          nextVisited,
        ),
      );
    } else {
      lines.push(padLine(branchSummary, width));
      lines.push(padLine(`${" ".repeat((depth + 1) * 4)}(sub workflow pending)`, width));
    }
  }

  return lines;
}

export function buildFlowchartLines(state: RendererState, width: number): string[] {
  const rootWorkflowIds = state.workflowOrder.filter((workflowId) => {
    const workflow = state.workflows.get(workflowId);
    return workflow && !workflow.parentWorkflowId;
  });

  if (rootWorkflowIds.length === 0 && state.workflowId) {
    rootWorkflowIds.push(state.workflowId);
  }

  if (rootWorkflowIds.length === 0) {
    return [padLine("workflow events are waiting...", width)];
  }

  const lines: string[] = [];
  for (const workflowId of rootWorkflowIds) {
    lines.push(...renderWorkflowBranchLines(state, workflowId, width, 0));
  }

  return lines;
}
