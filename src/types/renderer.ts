import type { ExecutionObserver, TaskLogColorTheme, TaskLogLevel } from "./observability.js";
import type { WorkflowRuntimeController } from "./workflow.js";

export type CLIRendererOptions = {
  enabled?: boolean;
  mode?: "off" | "line" | "compact" | "ink" | "dashboard" | "jsonl" | "plain";
  persistAfterCompletion?: boolean;
  stream?: NodeJS.WriteStream;
  errorStream?: NodeJS.WriteStream;
  debugLogStream?: NodeJS.ReadableStream;
  useColor?: boolean;
  colorTheme?: TaskLogColorTheme;
  colorConfigPath?: string;
  useUnicode?: boolean;
  refreshMs?: number;
  maxRecentEvents?: number;
  maxRecentLogs?: number;
  logLevel?: TaskLogLevel;
  width?: number;
  workflowController?: WorkflowRuntimeController;
};

export interface CLIRenderer extends ExecutionObserver {
  start(): void;
  stop(finalStatus?: "success" | "fail"): void;
  close(): void;
  resize?(width: number, height: number): void;
}
