import type {
  CLIRenderer,
  CLIRendererOptions,
  ExecutionEvent,
  TaskLogEvent,
  TaskLogLevel
} from "./types.js";

type ResolvedMode = "line" | "compact" | "jsonl" | "plain";
type RequestedMode = NonNullable<CLIRendererOptions["mode"]>;

type RendererState = {
  workflowId?: string;
  runId?: string;
  status?: string;
  currentTask?: string;
  activeTasks: Set<string>;
  completedTasks: string[];
  recentEvents: string[];
  recentLogs: TaskLogEvent[];
  artifactCount: number;
  memoryWrites: number;
  retryCount: number;
  errorCount: number;
};

function levelWeight(level: TaskLogLevel): number {
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

function formatClock(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toISOString().slice(11, 19);
}

function lineForEvent(event: ExecutionEvent): string {
  const prefix = `[${formatClock(event.timestamp)}]`;

  switch (event.type) {
    case "workflow.started":
      return `${prefix} workflow started ${event.summary}`;
    case "workflow.completed":
      return `${prefix} workflow completed ${event.summary}`;
    case "workflow.failed":
      return `${prefix} workflow failed ${event.summary}`;
    case "task.queued":
    case "task.started":
    case "task.completed":
    case "task.failed":
    case "task.retry_scheduled":
      return `${prefix} ${event.type} ${event.taskName} ${event.summary}`.trim();
    case "branch.started":
    case "branch.completed":
    case "join.waiting":
    case "join.completed":
      return `${prefix} ${event.type} ${event.branchId} ${event.summary}`.trim();
    default:
      return `${prefix} ${event.type} ${event.summary}`.trim();
  }
}

function lineForTaskLog(event: TaskLogEvent): string {
  const prefix = `[${formatClock(event.timestamp)}]`;
  const taskName = event.taskName ? ` ${event.taskName}` : "";
  return `${prefix} task ${event.level}${taskName} ${event.message}`;
}

function jsonForTaskLog(event: TaskLogEvent): string {
  return JSON.stringify({
    kind: "taskLog",
    ...event
  });
}

function jsonForEvent(event: ExecutionEvent): string {
  return JSON.stringify({
    kind: "event",
    ...event
  });
}

function sanitizeMode(mode?: RequestedMode): RequestedMode {
  return mode ?? "compact";
}

class DefaultCLIRenderer implements CLIRenderer {
  private readonly stream: NodeJS.WriteStream;
  private readonly options: Required<
    Pick<CLIRendererOptions, "enabled" | "refreshMs" | "maxRecentEvents" | "maxRecentLogs"> &
      Pick<CLIRendererOptions, "mode" | "logLevel">
  >;
  private readonly state: RendererState = {
    activeTasks: new Set(),
    completedTasks: [],
    recentEvents: [],
    recentLogs: [],
    artifactCount: 0,
    memoryWrites: 0,
    retryCount: 0,
    errorCount: 0
  };

  private started = false;
  private lastRenderLineCount = 0;
  private pendingRender: NodeJS.Timeout | null = null;
  private resolvedMode: ResolvedMode = "line";

  constructor(options: CLIRendererOptions = {}) {
    this.stream = options.stream ?? process.stdout;
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

  resize(): void {
    if (this.resolvedMode === "compact") {
      this.scheduleRender();
    }
  }

  onEvent(event: ExecutionEvent): void {
    this.start();
    this.reduceEvent(event);

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
        this.stream.write(`${lineForEvent(event)}\n`);
        break;
    }
  }

  onTaskLog(event: TaskLogEvent): void {
    this.start();

    if (levelWeight(event.level) < levelWeight(this.options.logLevel)) {
      return;
    }

    this.pushRecentLog(event);

    switch (this.resolvedMode) {
      case "compact":
        this.scheduleRender();
        break;
      case "jsonl":
        this.stream.write(`${jsonForTaskLog(event)}\n`);
        break;
      case "plain":
      case "line":
        this.stream.write(`${lineForTaskLog(event)}\n`);
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

    if ((this.stream as { isTTY?: boolean }).isTTY === false) {
      return "jsonl";
    }

    return "compact";
  }

  private reduceEvent(event: ExecutionEvent): void {
    this.state.workflowId = event.workflowId;
    this.state.runId = event.runId;
    this.state.recentEvents.push(lineForEvent(event));
    this.state.recentEvents = this.state.recentEvents.slice(-this.options.maxRecentEvents);

    switch (event.type) {
      case "workflow.started":
        this.state.status = "running";
        break;
      case "workflow.completed":
        this.state.status = event.status;
        this.state.activeTasks.clear();
        break;
      case "workflow.failed":
        this.state.status = event.status;
        this.state.errorCount += 1;
        this.state.activeTasks.clear();
        break;
      case "task.started":
        this.state.currentTask = event.taskName;
        this.state.activeTasks.add(event.taskName);
        break;
      case "task.completed":
        this.state.activeTasks.delete(event.taskName);
        this.state.completedTasks.push(event.taskName);
        this.state.completedTasks = this.state.completedTasks.slice(-5);
        break;
      case "task.failed":
        this.state.activeTasks.delete(event.taskName);
        this.state.errorCount += 1;
        break;
      case "task.retry_scheduled":
        this.state.retryCount += 1;
        break;
      case "memory.put":
        this.state.memoryWrites += 1;
        break;
      case "artifact.created":
        this.state.artifactCount += 1;
        break;
      default:
        break;
    }
  }

  private pushRecentLog(event: TaskLogEvent): void {
    const previous = this.state.recentLogs[this.state.recentLogs.length - 1];
    if (
      previous &&
      previous.taskName === event.taskName &&
      previous.level === event.level &&
      previous.message === event.message
    ) {
      this.state.recentLogs[this.state.recentLogs.length - 1] = event;
      return;
    }

    this.state.recentLogs.push(event);
    this.state.recentLogs = this.state.recentLogs.slice(-this.options.maxRecentLogs);
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
      `Recent log: ${
        this.state.recentLogs.length > 0
          ? this.state.recentLogs
              .slice(-3)
              .map((log) => `[${log.level}] ${log.taskName ?? "-"} ${log.message}`)
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

export function createCLIRenderer(options?: CLIRendererOptions): CLIRenderer {
  return new DefaultCLIRenderer(options);
}
