import { InkCLIRenderer } from "./ink-renderer.js";
import {
  colorizeRendererText,
  resolveTaskLogColorTheme,
  shouldUseRendererColors,
  taskLogLevelForExecutionEvent
} from "./renderer-colors.js";
import {
  createInitialRendererState,
  jsonForEvent,
  jsonForTaskLog,
  levelWeight,
  linesForEvent,
  lineForTaskLog,
  reduceExecutionEvent,
  type RendererResolvedMode
} from "./renderer-model.js";
import type {
  CLIRenderer,
  CLIRendererOptions,
  ExecutionEvent,
  ResolvedTaskLogColorTheme,
  TaskLogEvent
} from "./types.js";

type ResolvedMode = Exclude<RendererResolvedMode, "ink">;
type RequestedMode = NonNullable<CLIRendererOptions["mode"]>;

function sanitizeMode(mode?: RequestedMode): RequestedMode {
  return mode ?? "compact";
}

class DefaultCLIRenderer implements CLIRenderer {
  private readonly stream: NodeJS.WriteStream;
  private readonly useColor: boolean;
  private readonly colorTheme: ResolvedTaskLogColorTheme;
  private readonly options: Required<
    Pick<CLIRendererOptions, "enabled" | "refreshMs" | "maxRecentEvents" | "maxRecentLogs"> &
      Pick<CLIRendererOptions, "mode" | "logLevel">
  >;
  private readonly state = createInitialRendererState();

  private started = false;
  private lastRenderLineCount = 0;
  private pendingRender: NodeJS.Timeout | null = null;
  private resolvedMode: ResolvedMode = "line";

  constructor(options: CLIRendererOptions = {}) {
    this.stream = options.stream ?? process.stdout;
    this.useColor = shouldUseRendererColors(options, this.stream);
    this.colorTheme = resolveTaskLogColorTheme(options);
    this.options = {
      enabled: options.enabled ?? true,
      mode: sanitizeMode(options.mode),
      refreshMs: options.refreshMs ?? 100,
      maxRecentEvents: options.maxRecentEvents ?? 5,
      maxRecentLogs: options.maxRecentLogs ?? 5,
      logLevel: options.logLevel ?? "info"
    };
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    this.resolvedMode = this.resolveMode();
  }

  stop(): void {
    if (!this.started) {
      return;
    }

    if (this.pendingRender) {
      clearTimeout(this.pendingRender);
      this.pendingRender = null;
    }

    if (this.resolvedMode === "compact") {
      this.renderCompact(true);
      this.stream.write("\n");
    }

    this.started = false;
  }

  close(): void {
    this.stop();
  }

  resize(): void {
    if (this.resolvedMode === "compact") {
      this.scheduleRender();
    }
  }

  onEvent(event: ExecutionEvent): void {
    this.start();
    reduceExecutionEvent(this.state, event, this.options.maxRecentEvents, 80);

    if (event.type === "task.log") {
      return;
    }

    switch (this.resolvedMode) {
      case "compact":
        this.scheduleRender();
        break;
      case "jsonl":
        this.stream.write(`${jsonForEvent(event)}\n`);
        break;
      case "plain":
      case "line":
        for (const line of linesForEvent(event)) {
          this.stream.write(
            `${colorizeRendererText(line, taskLogLevelForExecutionEvent(event), this.colorTheme, this.useColor)}\n`
          );
        }
        break;
    }
  }

  onTaskLog(event: TaskLogEvent): void {
    this.start();

    if (levelWeight(event.level) < levelWeight(this.options.logLevel)) {
      return;
    }

    const previous = this.state.recentLogs[this.state.recentLogs.length - 1];
    if (
      previous &&
      previous.taskName === event.taskName &&
      previous.level === event.level &&
      previous.message === event.message
    ) {
      this.state.recentLogs[this.state.recentLogs.length - 1] = event;
    } else {
      this.state.recentLogs.push(event);
      this.state.recentLogs = this.state.recentLogs.slice(-this.options.maxRecentLogs);
    }

    switch (this.resolvedMode) {
      case "compact":
        this.scheduleRender();
        break;
      case "jsonl":
        this.stream.write(`${jsonForTaskLog(event)}\n`);
        break;
      case "plain":
      case "line":
        this.stream.write(
          `${colorizeRendererText(lineForTaskLog(event), event.level, this.colorTheme, this.useColor)}\n`
        );
        break;
    }
  }

  onFlush(): void {
    if (this.resolvedMode === "compact") {
      this.renderCompact(false);
    }
  }

  private resolveMode(): ResolvedMode {
    if (this.options.enabled === false) {
      return "line";
    }

    const requestedMode = this.options.mode;

    if (requestedMode === "off" || requestedMode === "line") {
      return "line";
    }

    if (requestedMode === "jsonl") {
      return "jsonl";
    }

    if (requestedMode === "plain") {
      return "plain";
    }

    if (requestedMode === "dashboard") {
      this.stream.write("[cycle] dashboard mode is not implemented yet; falling back to compact.\n");
      return "compact";
    }

    if (requestedMode === "ink" && (this.stream as { isTTY?: boolean }).isTTY !== true) {
      return "jsonl";
    }

    if ((this.stream as { isTTY?: boolean }).isTTY !== true) {
      return "jsonl";
    }

    return "compact";
  }

  private scheduleRender(): void {
    if (this.pendingRender) {
      return;
    }

    this.pendingRender = setTimeout(() => {
      this.pendingRender = null;
      this.renderCompact(false);
    }, this.options.refreshMs);
  }

  private renderCompact(finalRender: boolean): void {
    const lines = [
      `Cycle ${this.state.workflowId ?? "workflow"} run=${this.state.runId ?? "-"}`,
      `Status: ${this.state.status ?? "running"}  Current: ${this.state.currentTask ?? "-"}`,
      `Active: ${[...this.state.activeTasks].join(", ") || "-"}`,
      `Completed: ${this.state.completedTasks.join(", ") || "-"}`,
      `Counts: artifacts=${this.state.artifactCount} memoryWrites=${this.state.memoryWrites} retries=${this.state.retryCount} errors=${this.state.errorCount}`,
      colorizeRendererText(
        `Failure: ${this.state.lastFailure ?? "-"}`,
        this.state.lastFailure ? "error" : "info",
        this.colorTheme,
        this.useColor
      ),
      ...(
        this.state.lastFailureStack.length > 0
          ? this.state.lastFailureStack.map((line, index) =>
              colorizeRendererText(
                `${index === 0 ? "Stack:" : "     "} ${line}`,
                "error",
                this.colorTheme,
                this.useColor
              )
            )
          : []
      ),
      `Recent log: ${
        this.state.recentLogs.length > 0
          ? this.state.recentLogs
              .slice(-3)
              .map((log) =>
                colorizeRendererText(
                  `[${log.level}] ${log.taskName ?? "-"} ${log.message}`,
                  log.level,
                  this.colorTheme,
                  this.useColor
                )
              )
              .join(" | ")
          : "-"
      }`
    ];

    const frame = `${lines.join("\n")}${finalRender ? "" : "\n"}`;

    if (this.lastRenderLineCount > 0) {
      this.stream.write(`\u001B[${this.lastRenderLineCount}A`);
      for (let index = 0; index < this.lastRenderLineCount; index += 1) {
        this.stream.write("\u001B[2K\u001B[1B");
      }
      this.stream.write(`\u001B[${this.lastRenderLineCount}A`);
    }

    this.stream.write(frame);
    this.lastRenderLineCount = lines.length + (finalRender ? 0 : 1);
  }
}

function shouldUseInk(options: CLIRendererOptions): boolean {
  const requestedMode = options.mode;
  const stream = options.stream ?? process.stdout;

  return (
    options.enabled !== false &&
    requestedMode === "ink" &&
    (stream as { isTTY?: boolean }).isTTY === true &&
    process.stdin.isTTY === true
  );
}

function toClassicFallbackOptions(options: CLIRendererOptions): CLIRendererOptions {
  if (options.mode !== "ink") {
    return options;
  }

  return {
    ...options,
    mode:
      options.enabled === false
        ? "line"
        : (options.stream ?? process.stdout).isTTY !== true
          ? "jsonl"
          : "compact"
  };
}

export function createCLIRenderer(options: CLIRendererOptions = {}): CLIRenderer {
  if (shouldUseInk(options)) {
    return new InkCLIRenderer(options);
  }

  return new DefaultCLIRenderer(toClassicFallbackOptions(options));
}
