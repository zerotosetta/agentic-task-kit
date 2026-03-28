import { createInterface, type Interface as ReadLineInterface } from "node:readline";

import { render, Text, useInput } from "ink";
import { useEffect, useState, type ReactElement } from "react";

import {
  createInitialRendererState,
  levelWeight,
  pushDebugLogLine,
  pushTaskLog,
  reduceExecutionEvent,
  truncateText,
  type RendererState
} from "./renderer-model.js";
import type {
  CLIRenderer,
  CLIRendererOptions,
  ExecutionEvent,
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
};

const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 24;
const LEFT_MIN_WIDTH = 32;
const RIGHT_MIN_WIDTH = 48;
const HISTORY_BUFFER_SIZE = 240;
const TIMELINE_BUFFER_SIZE = 480;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function computeColumns(columns: number): { leftWidth: number; rightWidth: number } {
  const total = Math.max(columns, LEFT_MIN_WIDTH + RIGHT_MIN_WIDTH + 1);
  const leftWidth = clamp(Math.floor(total * 0.4), LEFT_MIN_WIDTH, total - RIGHT_MIN_WIDTH - 1);
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

function buildSummaryLines(state: RendererState): string[] {
  return [
    `Workflow ${state.workflowId ?? "-"}`,
    `Run      ${state.runId ?? "-"}`,
    `Status   ${state.status ?? "running"}`,
    `Current  ${state.currentTask ?? "-"}`,
    `Active   ${[...state.activeTasks].join(", ") || "-"}`,
    `Counts   art=${state.artifactCount} mem=${state.memoryWrites} retry=${state.retryCount} err=${state.errorCount}`,
    `Failure  ${state.lastFailure ?? "-"}`
  ];
}

function buildHeaderLine(state: RendererState, columns: number, focusedPane: InkPane): string {
  const text = `Cycle Ink  workflow=${state.workflowId ?? "-"}  status=${state.status ?? "running"}  focus=${focusedPane}`;
  return padLine(text, columns);
}

function buildFooterLine(columns: number, focusedPane: InkPane, rightAutoFollow: boolean): string {
  const text =
    `Tab pane  ↑↓/jk scroll  PgUp/PgDn page  Home/End,g/G edge  focus=${focusedPane}  follow=${rightAutoFollow ? "on" : "off"}`;
  return padLine(text, columns);
}

function withTitle(title: string, width: number, focused: boolean): string {
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
      next.rightScroll = next.rightAutoFollow ? action.rightMaxScroll : clamp(next.rightScroll, 0, action.rightMaxScroll);
      next.rightAutoFollow = next.rightScroll >= action.rightMaxScroll;
      return next;
  }
}

export function InkRendererScreen({
  state,
  columns,
  rows,
  finalStatus
}: InkRendererScreenProps): ReactElement {
  const [uiState, setUiState] = useState<InkUIState>({
    focusedPane: "right",
    leftScroll: 0,
    rightScroll: 0,
    rightAutoFollow: true
  });

  const { leftWidth, rightWidth } = computeColumns(columns);
  const usableRows = Math.max(rows, 12);
  const bodyHeight = Math.max(usableRows - 2, 8);
  const leftSummaryLines = buildSummaryLines(state).map((line) => padLine(line, leftWidth));
  const leftHistoryViewport = Math.max(bodyHeight - leftSummaryLines.length - 1, 1);
  const rightViewport = Math.max(bodyHeight - 1, 1);
  const leftHistoryLines = state.taskHistory.map((row) => padLine(row.text, leftWidth));
  const rightLines = state.timeline.map((row) => padLine(row.text, rightWidth));
  const metrics = {
    leftMaxScroll: maxScroll(leftHistoryLines.length, leftHistoryViewport),
    rightMaxScroll: maxScroll(rightLines.length, rightViewport),
    pageSize: Math.max(1, Math.min(leftHistoryViewport, rightViewport) - 1)
  };

  useEffect(() => {
    setUiState((current) =>
      reduceInkUIState(current, {
        type: "sync",
        leftMaxScroll: metrics.leftMaxScroll,
        rightMaxScroll: metrics.rightMaxScroll
      }, metrics)
    );
  }, [metrics.leftMaxScroll, metrics.rightMaxScroll, metrics.pageSize]);

  useInput((input, key) => {
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

  const leftPanelLines = [
    withTitle(`Workflow + History (${state.taskHistory.length})`, leftWidth, uiState.focusedPane === "left"),
    ...leftSummaryLines,
    ...visibleWindow(leftHistoryLines, uiState.leftScroll, leftHistoryViewport)
  ];
  while (leftPanelLines.length < bodyHeight) {
    leftPanelLines.push(" ".repeat(leftWidth));
  }

  const rightPanelLines = [
    withTitle(
      `Logs (${state.timeline.length}) follow=${uiState.rightAutoFollow ? "on" : "off"}`,
      rightWidth,
      uiState.focusedPane === "right"
    ),
    ...visibleWindow(rightLines, uiState.rightScroll, rightViewport)
  ];
  while (rightPanelLines.length < bodyHeight) {
    rightPanelLines.push(" ".repeat(rightWidth));
  }

  const mergedBodyLines: string[] = [];
  for (let index = 0; index < bodyHeight; index += 1) {
    mergedBodyLines.push(`${leftPanelLines[index] ?? " ".repeat(leftWidth)}│${rightPanelLines[index] ?? " ".repeat(rightWidth)}`);
  }

  return (
    <>
      <Text>{buildHeaderLine(state, columns, uiState.focusedPane)}</Text>
      {mergedBodyLines.map((line, index) => (
        <Text key={`body-${index}`}>{line}</Text>
      ))}
      <Text>{buildFooterLine(columns, uiState.focusedPane, uiState.rightAutoFollow)}</Text>
      {finalStatus ? <Text>{padLine(`Final status: ${finalStatus}`, columns)}</Text> : null}
    </>
  );
}

type InkRendererResolvedOptions = Required<
  Pick<CLIRendererOptions, "enabled" | "refreshMs" | "maxRecentEvents" | "maxRecentLogs"> &
    Pick<CLIRendererOptions, "mode" | "logLevel">
> & {
  stream: NodeJS.WriteStream;
  errorStream: NodeJS.WriteStream;
  debugLogStream?: NodeJS.ReadableStream;
};

export class InkCLIRenderer implements CLIRenderer {
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

  constructor(options: CLIRendererOptions = {}) {
    this.options = {
      enabled: options.enabled ?? true,
      mode: options.mode ?? "ink",
      refreshMs: options.refreshMs ?? 100,
      maxRecentEvents: Math.max(options.maxRecentEvents ?? 5, 8),
      maxRecentLogs: Math.max(options.maxRecentLogs ?? 5, 8),
      logLevel: options.logLevel ?? "info",
      stream: options.stream ?? process.stdout,
      errorStream: options.errorStream ?? process.stderr,
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
    this.renderNow();
  }

  stop(finalStatus?: "success" | "fail"): void {
    if (!this.started) {
      return;
    }

    this.finalStatus.value = finalStatus;
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

    this.inkInstance?.unmount();
    this.inkInstance = null;
    this.leaveAlternateScreen();
    this.writeFinalSummary();
    this.started = false;
  }

  resize(width: number, height: number): void {
    this.columns.value = width;
    this.rows.value = height;
    this.scheduleRender();
  }

  onEvent(event: ExecutionEvent): void {
    this.start();
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

  private scheduleRender(): void {
    if (this.pendingRender) {
      return;
    }

    this.pendingRender = setTimeout(() => {
      this.pendingRender = null;
      this.renderNow();
    }, this.options.refreshMs);
  }

  private renderNow(): void {
    const tree = (
      <InkRendererScreen
        state={this.state}
        columns={this.columns.value}
        rows={this.rows.value}
        finalStatus={this.finalStatus.value}
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
      exitOnCtrlC: true,
      patchConsole: true
    });
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
