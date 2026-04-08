import { createInterface, type Interface as ReadLineInterface } from "node:readline";

import { render, Text, useInput } from "ink";
import React, { useEffect, useState, type ReactElement } from "react";

import {
  inkColorForLevel,
  resolveTaskLogColorTheme,
  shouldUseRendererColors
} from "./renderer-colors.js";
import { getGlobalWorkflowRuntimeController } from "./runtime-control.js";
import {
  createInitialRendererState,
  formatDuration,
  getTaskDurationMs,
  levelWeight,
  pushDebugLogLine,
  pushTaskLog,
  reduceExecutionEvent,
  truncateText,
  type RendererState,
  type TimelineRow,
  type WorkflowRenderState,
  type WorkflowTaskState
} from "./renderer-model.js";
import type {
  CLIRenderer,
  CLIRendererOptions,
  ExecutionEvent,
  ResolvedTaskLogColorTheme,
  TaskLogEvent
} from "./types.js";

type InkPane = "left" | "right";

export type InkUIState = {
  focusedPane: InkPane;
  leftScroll: number;
  rightScroll: number;
  rightAutoFollow: boolean;
};

type InkUIAction =
  | { type: "focus.toggle" }
  | { type: "scroll.line"; delta: number }
  | { type: "scroll.page"; delta: number }
  | { type: "scroll.start" }
  | { type: "scroll.end" }
  | { type: "sync"; leftMaxScroll: number; rightMaxScroll: number };

type InkScrollMetrics = {
  leftMaxScroll: number;
  rightMaxScroll: number;
  pageSize: number;
};

type InkRendererScreenProps = {
  state: RendererState;
  columns: number;
  rows: number;
  finalStatus: "success" | "fail" | undefined;
  useColor: boolean;
  colorTheme: ResolvedTaskLogColorTheme;
  onInterrupt?: () => void;
};

const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 24;
const LEFT_MIN_WIDTH = 36;
const RIGHT_MIN_WIDTH = 42;
const HISTORY_BUFFER_SIZE = 240;
const TIMELINE_BUFFER_SIZE = 480;
const TASK_BOX_INNER_WIDTH = 16;

type InkInputKey = {
  ctrl?: boolean;
  name?: string;
  sequence?: string;
  tab?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  pageUp?: boolean;
  pageDown?: boolean;
  home?: boolean;
  end?: boolean;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeBottomColumns(columns: number): { leftWidth: number; rightWidth: number } {
  const total = Math.max(columns, LEFT_MIN_WIDTH + RIGHT_MIN_WIDTH + 1);
  const leftWidth = clamp(Math.floor(total * 0.48), LEFT_MIN_WIDTH, total - RIGHT_MIN_WIDTH - 1);
  const rightWidth = total - leftWidth - 1;
  return {
    leftWidth,
    rightWidth
  };
}

function padLine(value: string, width: number): string {
  const clipped = truncateText(value, width);
  return clipped.length >= width ? clipped : clipped.padEnd(width, " ");
}

function buildHeaderLine(state: RendererState, columns: number): string {
  const text =
    `Cycle Ink  workflow=${state.workflowId ?? "-"}  status=${state.status ?? "running"}  current=${state.currentTask ?? "-"}  ` +
    `art=${state.artifactCount} mem=${state.memoryWrites} retry=${state.retryCount} err=${state.errorCount}`;
  return padLine(text, columns);
}

function buildFooterLine(columns: number, focusedPane: InkPane, rightAutoFollow: boolean): string {
  const text =
    `Tab pane  up/down,j/k scroll  PgUp/PgDn page  Home/End,g/G edge  focus=${focusedPane}  follow=${rightAutoFollow ? "on" : "off"}`;
  return padLine(text, columns);
}

function withTitle(title: string, width: number, focused = false): string {
  return padLine(`${focused ? ">" : " "} ${title}`, width);
}

function visibleWindow(lines: string[], start: number, size: number): string[] {
  if (size <= 0) {
    return [];
  }

  return lines.slice(start, start + size);
}

function maxScroll(lineCount: number, viewportSize: number): number {
  return Math.max(0, lineCount - viewportSize);
}

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
  indent: number
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
  now: number
): string[] {
  if (tasks.length === 0) {
    const idleTask: WorkflowTaskState = {
      taskName: "waiting",
      status: "queued",
      updatedAt: now
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
  visited = new Set<string>()
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
  const workflowLabel =
    `${workflow.name} [${workflowStatusLabel(workflow.status)} ${formatDuration(workflowDurationMs(workflow, now))}]`;

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
          nextVisited
        )
      );
    } else {
      lines.push(padLine(branchSummary, width));
      lines.push(padLine(`${" ".repeat((depth + 1) * 4)}(sub workflow pending)`, width));
    }
  }

  return lines;
}

function buildFlowchartLines(state: RendererState, width: number): string[] {
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

export function reduceInkUIState(
  state: InkUIState,
  action: InkUIAction,
  metrics: InkScrollMetrics
): InkUIState {
  const next = { ...state };
  const pane = state.focusedPane;
  const scrollKey = pane === "left" ? "leftScroll" : "rightScroll";
  const maxForPane = pane === "left" ? metrics.leftMaxScroll : metrics.rightMaxScroll;

  const setScroll = (value: number): void => {
    next[scrollKey] = clamp(value, 0, maxForPane);
    if (pane === "right") {
      next.rightAutoFollow = next.rightScroll >= metrics.rightMaxScroll;
    }
  };

  switch (action.type) {
    case "focus.toggle":
      next.focusedPane = pane === "left" ? "right" : "left";
      return next;
    case "scroll.line":
      setScroll(next[scrollKey] + action.delta);
      return next;
    case "scroll.page":
      setScroll(next[scrollKey] + action.delta * metrics.pageSize);
      return next;
    case "scroll.start":
      setScroll(0);
      return next;
    case "scroll.end":
      setScroll(maxForPane);
      return next;
    case "sync":
      next.leftScroll = clamp(next.leftScroll, 0, action.leftMaxScroll);
      next.rightScroll = next.rightAutoFollow
        ? action.rightMaxScroll
        : clamp(next.rightScroll, 0, action.rightMaxScroll);
      next.rightAutoFollow = next.rightScroll >= action.rightMaxScroll;
      return next;
  }
}

export function isInkInterruptInput(input: string, key: InkInputKey): boolean {
  if (input === "\u0003" || key.sequence === "\u0003") {
    return true;
  }

  return key.ctrl === true && (input.toLowerCase() === "c" || key.name === "c");
}

export function InkRendererScreen({
  state,
  columns,
  rows,
  finalStatus,
  useColor,
  colorTheme,
  onInterrupt
}: InkRendererScreenProps): ReactElement {
  const [uiState, setUiState] = useState<InkUIState>({
    focusedPane: "right",
    leftScroll: 0,
    rightScroll: 0,
    rightAutoFollow: true
  });

  const { leftWidth, rightWidth } = computeBottomColumns(columns);
  const usableRows = Math.max(rows, 16);
  const footerRows = finalStatus ? 3 : 2;
  const contentRows = Math.max(usableRows - footerRows, 10);
  const flowchartLines = buildFlowchartLines(state, columns);
  const flowchartViewport = clamp(flowchartLines.length, 6, Math.max(6, contentRows - 6));
  const bottomViewport = Math.max(4, contentRows - flowchartViewport - 2);
  const leftLines = state.taskHistory.map((row) => padLine(row.text, leftWidth));
  const rightRows = state.timeline;
  const metrics = {
    leftMaxScroll: maxScroll(leftLines.length, bottomViewport),
    rightMaxScroll: maxScroll(rightRows.length, bottomViewport),
    pageSize: Math.max(1, bottomViewport - 1)
  };

  useEffect(() => {
    setUiState((current) =>
      reduceInkUIState(
        current,
        {
          type: "sync",
          leftMaxScroll: metrics.leftMaxScroll,
          rightMaxScroll: metrics.rightMaxScroll
        },
        metrics
      )
    );
  }, [metrics.leftMaxScroll, metrics.rightMaxScroll, metrics.pageSize]);

  useInput((input, key) => {
    if (isInkInterruptInput(input, key)) {
      onInterrupt?.();
      return;
    }

    if (key.tab || input === "\t") {
      setUiState((current) => reduceInkUIState(current, { type: "focus.toggle" }, metrics));
      return;
    }

    if (key.upArrow || input === "k") {
      setUiState((current) => reduceInkUIState(current, { type: "scroll.line", delta: -1 }, metrics));
      return;
    }

    if (key.downArrow || input === "j") {
      setUiState((current) => reduceInkUIState(current, { type: "scroll.line", delta: 1 }, metrics));
      return;
    }

    if (key.pageUp) {
      setUiState((current) => reduceInkUIState(current, { type: "scroll.page", delta: -1 }, metrics));
      return;
    }

    if (key.pageDown) {
      setUiState((current) => reduceInkUIState(current, { type: "scroll.page", delta: 1 }, metrics));
      return;
    }

    if (key.home || input === "g") {
      setUiState((current) => reduceInkUIState(current, { type: "scroll.start" }, metrics));
      return;
    }

    if (key.end || input === "G") {
      setUiState((current) => reduceInkUIState(current, { type: "scroll.end" }, metrics));
    }
  });

  const topPanelLines = [
    withTitle("워크플로우 파이프라인 플로우차트", columns),
    ...visibleWindow(flowchartLines, 0, flowchartViewport)
  ];
  while (topPanelLines.length < flowchartViewport + 1) {
    topPanelLines.push(" ".repeat(columns));
  }

  const bottomTitleLine =
    `${withTitle("워크플로우 task 실행 이력", leftWidth, uiState.focusedPane === "left")}│` +
    `${withTitle(`실행 로그 (${state.timeline.length})`, rightWidth, uiState.focusedPane === "right")}`;

  const leftPanelLines = visibleWindow(leftLines, uiState.leftScroll, bottomViewport);
  const rightPanelRows = rightRows.slice(uiState.rightScroll, uiState.rightScroll + bottomViewport);
  while (leftPanelLines.length < bottomViewport) {
    leftPanelLines.push(" ".repeat(leftWidth));
  }
  while (rightPanelRows.length < bottomViewport) {
    rightPanelRows.push({
      id: `empty:${rightPanelRows.length}`,
      timestamp: 0,
      level: "info",
      source: "task",
      text: ""
    });
  }

  const mergedBottomLines: Array<{ id: string; left: string; right: string; level: TimelineRow["level"] }> = [];
  for (let index = 0; index < bottomViewport; index += 1) {
    const row = rightPanelRows[index];
    mergedBottomLines.push({
      id: row?.id ?? `row:${index}`,
      left: leftPanelLines[index] ?? " ".repeat(leftWidth),
      right: padLine(row?.text ?? "", rightWidth),
      level: row?.level ?? "info"
    });
  }

  return (
    <>
      <Text>{buildHeaderLine(state, columns)}</Text>
      {topPanelLines.map((line, index) => (
        <Text key={`top-${index}`}>{line}</Text>
      ))}
      <Text>{bottomTitleLine}</Text>
      {mergedBottomLines.map((line) => (
        <Text key={line.id}>
          <Text>{line.left}</Text>
          <Text>│</Text>
          {useColor ? (
            <Text color={inkColorForLevel(line.level, colorTheme)}>{line.right}</Text>
          ) : (
            <Text>{line.right}</Text>
          )}
        </Text>
      ))}
      <Text>{buildFooterLine(columns, uiState.focusedPane, uiState.rightAutoFollow)}</Text>
      {finalStatus ? <Text>{padLine(`Final status: ${finalStatus}`, columns)}</Text> : null}
    </>
  );
}

type InkRendererResolvedOptions = Required<
  Pick<CLIRendererOptions, "enabled" | "refreshMs" | "maxRecentEvents" | "maxRecentLogs" | "persistAfterCompletion"> &
    Pick<CLIRendererOptions, "mode" | "logLevel">
> & {
  stream: NodeJS.WriteStream;
  errorStream: NodeJS.WriteStream;
  workflowController: NonNullable<CLIRendererOptions["workflowController"]>;
  debugLogStream?: NodeJS.ReadableStream;
  useColor: boolean;
  colorTheme: ResolvedTaskLogColorTheme;
};

export class InkCLIRenderer implements CLIRenderer {
  private static readonly SIGNAL_EXIT_CODE = 130;
  private readonly options: InkRendererResolvedOptions;
  private readonly state = createInitialRendererState();
  private readonly columns: { value: number };
  private readonly rows: { value: number };
  private readonly finalStatus: { value: "success" | "fail" | undefined };
  private started = false;
  private alternateScreenActive = false;
  private pendingRender: NodeJS.Timeout | null = null;
  private inkInstance: ReturnType<typeof render> | null = null;
  private debugLineReader: ReadLineInterface | null = null;
  private resizeHandler: (() => void) | null = null;
  private interruptCancellationRequested = false;
  private exitAfterWorkflowCancellation = false;
  private readonly processSignalHandler = (): void => {
    if (this.options.workflowController.hasActiveRuns()) {
      this.requestWorkflowCancellation();
      return;
    }

    this.shutdown({
      writeSummary: false,
      exitProcess: true,
      exitCode: 0
    });
  };

  constructor(options: CLIRendererOptions = {}) {
    this.options = {
      enabled: options.enabled ?? true,
      mode: options.mode ?? "ink",
      refreshMs: options.refreshMs ?? 100,
      maxRecentEvents: Math.max(options.maxRecentEvents ?? 5, 8),
      maxRecentLogs: Math.max(options.maxRecentLogs ?? 5, 8),
      persistAfterCompletion: options.persistAfterCompletion ?? true,
      logLevel: options.logLevel ?? "info",
      stream: options.stream ?? process.stdout,
      errorStream: options.errorStream ?? process.stderr,
      workflowController: options.workflowController ?? getGlobalWorkflowRuntimeController(),
      useColor: shouldUseRendererColors(options, options.stream ?? process.stdout),
      colorTheme: resolveTaskLogColorTheme(options),
      ...(options.debugLogStream ? { debugLogStream: options.debugLogStream } : {})
    };
    this.columns = {
      value: options.width ?? this.options.stream.columns ?? process.stdout.columns ?? DEFAULT_COLUMNS
    };
    this.rows = {
      value: this.options.stream.rows ?? process.stdout.rows ?? DEFAULT_ROWS
    };
    this.finalStatus = {
      value: undefined
    };
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.enterAlternateScreen();
    this.attachResizeHandler();
    this.attachDebugStream();
    this.attachProcessSignalHandlers();
    this.renderNow();
  }

  stop(finalStatus?: "success" | "fail"): void {
    if (!this.started) {
      return;
    }

    this.finalStatus.value = finalStatus;
    this.renderNow();

    if (this.exitAfterWorkflowCancellation) {
      this.shutdown({
        writeSummary: true,
        exitProcess: true,
        exitCode: InkCLIRenderer.SIGNAL_EXIT_CODE
      });
      return;
    }

    if (this.options.persistAfterCompletion) {
      return;
    }

    this.close();
  }

  close(): void {
    this.shutdown({
      writeSummary: true
    });
  }

  private shutdown(args: {
    writeSummary: boolean;
    exitProcess?: boolean;
    exitCode?: number;
  }): void {
    if (!this.started) {
      if (args.exitProcess) {
        process.exit(args.exitCode ?? 0);
      }
      return;
    }

    if (this.pendingRender) {
      clearTimeout(this.pendingRender);
      this.pendingRender = null;
    }

    this.debugLineReader?.close();
    this.debugLineReader = null;

    if (this.resizeHandler) {
      this.options.stream.off("resize", this.resizeHandler);
      this.resizeHandler = null;
    }

    this.detachProcessSignalHandlers();
    this.inkInstance?.unmount();
    this.inkInstance = null;
    this.leaveAlternateScreen();
    this.started = false;
    this.exitAfterWorkflowCancellation = false;
    this.interruptCancellationRequested = false;

    if (args.writeSummary) {
      this.writeFinalSummary();
    }

    if (args.exitProcess) {
      process.exit(args.exitCode ?? 0);
    }
  }

  resize(width: number, height: number): void {
    this.columns.value = width;
    this.rows.value = height;
    this.scheduleRender();
  }

  onEvent(event: ExecutionEvent): void {
    this.start();
    if (event.type === "workflow.started") {
      this.finalStatus.value = undefined;
    }
    reduceExecutionEvent(
      this.state,
      event,
      this.options.maxRecentEvents,
      HISTORY_BUFFER_SIZE
    );

    if (event.type !== "task.log") {
      this.scheduleRender();
    }
  }

  onTaskLog(event: TaskLogEvent): void {
    this.start();

    if (levelWeight(event.level) < levelWeight(this.options.logLevel)) {
      return;
    }

    pushTaskLog(
      this.state,
      event,
      this.options.maxRecentLogs,
      TIMELINE_BUFFER_SIZE
    );
    this.scheduleRender();
  }

  onFlush(): void {
    this.renderNow();
  }

  private attachResizeHandler(): void {
    if (typeof this.options.stream.on !== "function") {
      return;
    }

    this.resizeHandler = () => {
      this.columns.value = this.options.stream.columns ?? process.stdout.columns ?? this.columns.value;
      this.rows.value = this.options.stream.rows ?? process.stdout.rows ?? this.rows.value;
      this.scheduleRender();
    };
    this.options.stream.on("resize", this.resizeHandler);
  }

  private attachDebugStream(): void {
    if (!this.options.debugLogStream) {
      return;
    }

    this.debugLineReader = createInterface({
      input: this.options.debugLogStream
    });
    this.debugLineReader.on("line", (line) => {
      if (levelWeight("debug") < levelWeight(this.options.logLevel)) {
        return;
      }

      pushDebugLogLine(
        this.state,
        line,
        Date.now(),
        TIMELINE_BUFFER_SIZE
      );
      this.scheduleRender();
    });
  }

  private requestWorkflowCancellation(): void {
    if (this.interruptCancellationRequested) {
      return;
    }

    this.interruptCancellationRequested = true;
    this.exitAfterWorkflowCancellation = true;
    pushDebugLogLine(
      this.state,
      "[cycle:signal] Ctrl+C received, cancelling active workflow and exiting when the run stops...",
      Date.now(),
      TIMELINE_BUFFER_SIZE
    );
    this.scheduleRender();

    Promise.resolve(this.options.workflowController.cancelActiveRuns("Workflow cancelled by Ctrl+C."))
      .catch((error) => {
        pushDebugLogLine(
          this.state,
          `[cycle:signal] cancellation request failed: ${error instanceof Error ? error.message : String(error)}`,
          Date.now(),
          TIMELINE_BUFFER_SIZE
        );
        this.shutdown({
          writeSummary: false,
          exitProcess: true,
          exitCode: 1
        });
      })
      .finally(() => {
        this.interruptCancellationRequested = false;
        this.scheduleRender();
      });
  }

  private scheduleRender(): void {
    if (!this.started) {
      return;
    }

    if (this.pendingRender) {
      return;
    }

    this.pendingRender = setTimeout(() => {
      this.pendingRender = null;
      this.renderNow();
    }, this.options.refreshMs);
  }

  private renderNow(): void {
    if (!this.started) {
      return;
    }

    const tree = (
      <InkRendererScreen
        state={this.state}
        columns={this.columns.value}
        rows={this.rows.value}
        finalStatus={this.finalStatus.value}
        useColor={this.options.useColor}
        colorTheme={this.options.colorTheme}
        onInterrupt={() => {
          this.processSignalHandler();
        }}
      />
    );

    if (this.inkInstance) {
      this.inkInstance.rerender(tree);
      return;
    }

    this.inkInstance = render(tree, {
      stdout: this.options.stream,
      stderr: this.options.errorStream,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: true
    });
  }

  private attachProcessSignalHandlers(): void {
    process.on("SIGINT", this.processSignalHandler);
    process.on("SIGTERM", this.processSignalHandler);
  }

  private detachProcessSignalHandlers(): void {
    process.off("SIGINT", this.processSignalHandler);
    process.off("SIGTERM", this.processSignalHandler);
  }

  private enterAlternateScreen(): void {
    if (this.alternateScreenActive || this.options.stream.isTTY !== true) {
      return;
    }

    this.options.stream.write("\u001B[?1049h\u001B[2J\u001B[H");
    this.alternateScreenActive = true;
  }

  private leaveAlternateScreen(): void {
    if (!this.alternateScreenActive || this.options.stream.isTTY !== true) {
      return;
    }

    this.options.stream.write("\u001B[?1049l");
    this.alternateScreenActive = false;
  }

  private writeFinalSummary(): void {
    const status = this.finalStatus.value ?? this.state.status;
    if (!status) {
      return;
    }

    const parts = [
      `Cycle ${this.state.workflowId ?? "workflow"} finished`,
      `status=${status}`
    ];

    if (this.state.currentTask) {
      parts.push(`current=${this.state.currentTask}`);
    }

    if (this.state.lastFailure) {
      parts.push(`failure=${this.state.lastFailure}`);
    }

    this.options.stream.write(`${parts.join(" ")}\n`);
  }
}
