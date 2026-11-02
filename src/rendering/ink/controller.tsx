import { render } from "ink";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";
import { createElement } from "react";
import { exitAfterTerminalCleanup } from "../../process-exit.js";
import { resolveTaskLogColorTheme, shouldUseRendererColors } from "../../renderer-colors.js";
import {
  createInitialRendererState,
  levelWeight,
  pushDebugLogLine,
  pushTaskLog,
  reduceExecutionEvent,
} from "../../renderer-model.js";
import { getGlobalWorkflowRuntimeController } from "../../runtime-control.js";
import type {
  CLIRenderer,
  CLIRendererOptions,
  ExecutionEvent,
  ResolvedTaskLogColorTheme,
  TaskLogEvent,
} from "../../types.js";
import {
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  HISTORY_BUFFER_SIZE,
  TIMELINE_BUFFER_SIZE,
} from "./model.js";
import { InkRendererScreen } from "./screen.js";

type InkRendererResolvedOptions = Required<
  Pick<
    CLIRendererOptions,
    "enabled" | "refreshMs" | "maxRecentEvents" | "maxRecentLogs" | "persistAfterCompletion"
  > &
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
  private exitAfterWorkflowCancellation: number | null = null;
  private readonly processSignalHandler = (): void => {
    if (this.options.workflowController.hasActiveRuns()) {
      this.requestWorkflowCancellation({
        reason: "Workflow cancelled by Ctrl+C.",
        message:
          "[cycle:signal] Ctrl+C received, cancelling active workflow and exiting when the run stops...",
        exitCode: InkCLIRenderer.SIGNAL_EXIT_CODE,
      });
      return;
    }

    this.shutdown({
      writeSummary: false,
      exitProcess: true,
      exitCode: 0,
    });
  };
  private readonly processQuitHandler = (): void => {
    if (this.options.workflowController.hasActiveRuns()) {
      this.requestWorkflowCancellation({
        reason: "Workflow cancelled by quit key.",
        message:
          "[cycle:signal] q received, cancelling active workflow and exiting when the run stops...",
        exitCode: 0,
      });
      return;
    }

    this.shutdown({
      writeSummary: false,
      exitProcess: true,
      exitCode: 0,
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
      ...(options.debugLogStream ? { debugLogStream: options.debugLogStream } : {}),
    };
    this.columns = {
      value:
        options.width ?? this.options.stream.columns ?? process.stdout.columns ?? DEFAULT_COLUMNS,
    };
    this.rows = {
      value: this.options.stream.rows ?? process.stdout.rows ?? DEFAULT_ROWS,
    };
    this.finalStatus = {
      value: undefined,
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

    if (this.exitAfterWorkflowCancellation !== null) {
      this.shutdown({
        writeSummary: true,
        exitProcess: true,
        exitCode: this.exitAfterWorkflowCancellation,
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
      writeSummary: true,
    });
  }

  private shutdown(args: {
    writeSummary: boolean;
    exitProcess?: boolean;
    exitCode?: number;
  }): void {
    if (!this.started) {
      if (args.exitProcess) {
        exitAfterTerminalCleanup(args.exitCode ?? 0);
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
    this.exitAfterWorkflowCancellation = null;
    this.interruptCancellationRequested = false;

    if (args.writeSummary) {
      this.writeFinalSummary();
    }

    if (args.exitProcess) {
      exitAfterTerminalCleanup(args.exitCode ?? 0);
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
    reduceExecutionEvent(this.state, event, this.options.maxRecentEvents, HISTORY_BUFFER_SIZE);

    if (event.type !== "task.log") {
      this.scheduleRender();
    }
  }

  onTaskLog(event: TaskLogEvent): void {
    this.start();

    if (levelWeight(event.level) < levelWeight(this.options.logLevel)) {
      return;
    }

    pushTaskLog(this.state, event, this.options.maxRecentLogs, TIMELINE_BUFFER_SIZE);
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
      this.columns.value =
        this.options.stream.columns ?? process.stdout.columns ?? this.columns.value;
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
      input: this.options.debugLogStream,
    });
    this.debugLineReader.on("line", (line) => {
      if (levelWeight("debug") < levelWeight(this.options.logLevel)) {
        return;
      }

      pushDebugLogLine(this.state, line, Date.now(), TIMELINE_BUFFER_SIZE);
      this.scheduleRender();
    });
  }

  private requestWorkflowCancellation(args: {
    reason: string;
    message: string;
    exitCode: number;
  }): void {
    if (this.interruptCancellationRequested) {
      return;
    }

    this.interruptCancellationRequested = true;
    this.exitAfterWorkflowCancellation = args.exitCode;
    pushDebugLogLine(this.state, args.message, Date.now(), TIMELINE_BUFFER_SIZE);
    this.scheduleRender();

    Promise.resolve(this.options.workflowController.cancelActiveRuns(args.reason))
      .catch((error) => {
        pushDebugLogLine(
          this.state,
          `[cycle:signal] cancellation request failed: ${error instanceof Error ? error.message : String(error)}`,
          Date.now(),
          TIMELINE_BUFFER_SIZE,
        );
        this.shutdown({
          writeSummary: false,
          exitProcess: true,
          exitCode: 1,
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

    const tree = createElement(InkRendererScreen, {
      state: this.state,
      columns: this.columns.value,
      rows: this.rows.value,
      finalStatus: this.finalStatus.value,
      useColor: this.options.useColor,
      colorTheme: this.options.colorTheme,
      onInterrupt: () => {
        this.processSignalHandler();
      },
      onQuit: () => {
        this.processQuitHandler();
      },
    });

    if (this.inkInstance) {
      this.inkInstance.rerender(tree);
      return;
    }

    this.inkInstance = render(tree, {
      stdout: this.options.stream,
      stderr: this.options.errorStream,
      stdin: process.stdin,
      exitOnCtrlC: false,
      patchConsole: true,
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

    const parts = [`Cycle ${this.state.workflowId ?? "workflow"} finished`, `status=${status}`];

    if (this.state.currentTask) {
      parts.push(`current=${this.state.currentTask}`);
    }

    if (this.state.lastFailure) {
      parts.push(`failure=${this.state.lastFailure}`);
    }

    this.options.stream.write(`${parts.join(" ")}\n`);
  }
}
