import { readFileSync } from "node:fs";

import type {
  CLIRendererOptions,
  ExecutionEvent,
  RendererColorName,
  ResolvedTaskLogColorTheme,
  TaskLogColorTheme,
  TaskLogLevel
} from "./types.js";

const ANSI_CODES: Record<RendererColorName, string> = {
  black: "\u001B[30m",
  red: "\u001B[31m",
  green: "\u001B[32m",
  yellow: "\u001B[33m",
  blue: "\u001B[34m",
  magenta: "\u001B[35m",
  cyan: "\u001B[36m",
  white: "\u001B[37m",
  gray: "\u001B[90m"
};

const ANSI_RESET = "\u001B[39m";

export const DEFAULT_TASK_LOG_COLOR_THEME: ResolvedTaskLogColorTheme = {
  debug: "gray",
  info: "cyan",
  warn: "yellow",
  error: "red",
  success: "green"
};

function isRendererColorName(value: unknown): value is RendererColorName {
  return (
    typeof value === "string" &&
    value in ANSI_CODES
  );
}

function toColorThemeRecord(value: unknown): TaskLogColorTheme {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const theme: TaskLogColorTheme = {};
  for (const level of ["debug", "info", "warn", "error", "success"] as const) {
    const candidate = (value as Record<string, unknown>)[level];
    if (isRendererColorName(candidate)) {
      theme[level] = candidate;
    }
  }

  return theme;
}

function readColorThemeFromParsedConfig(parsed: unknown): TaskLogColorTheme {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const root = parsed as Record<string, unknown>;
  return {
    ...toColorThemeRecord(root.colors),
    ...toColorThemeRecord(root.renderer && typeof root.renderer === "object" ? (root.renderer as Record<string, unknown>).colors : undefined),
    ...toColorThemeRecord(root.cliRenderer && typeof root.cliRenderer === "object" ? (root.cliRenderer as Record<string, unknown>).colors : undefined)
  };
}

export function loadCLIRendererColorThemeFromConfigFile(configPath: string): TaskLogColorTheme {
  const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
  return readColorThemeFromParsedConfig(parsed);
}

export function resolveTaskLogColorTheme(options: Pick<CLIRendererOptions, "colorConfigPath" | "colorTheme">): ResolvedTaskLogColorTheme {
  const fileTheme = options.colorConfigPath
    ? loadCLIRendererColorThemeFromConfigFile(options.colorConfigPath)
    : {};

  return {
    ...DEFAULT_TASK_LOG_COLOR_THEME,
    ...fileTheme,
    ...(options.colorTheme ?? {})
  };
}

export function shouldUseRendererColors(
  options: Pick<CLIRendererOptions, "useColor">,
  stream: NodeJS.WriteStream
): boolean {
  return options.useColor ?? stream.isTTY === true;
}

export function colorizeRendererText(
  text: string,
  level: TaskLogLevel,
  theme: ResolvedTaskLogColorTheme,
  enabled: boolean
): string {
  if (!enabled) {
    return text;
  }

  const open = ANSI_CODES[theme[level]];
  return `${open}${text}${ANSI_RESET}`;
}

export function inkColorForLevel(
  level: TaskLogLevel,
  theme: ResolvedTaskLogColorTheme
): RendererColorName {
  return theme[level];
}

export function taskLogLevelForExecutionEvent(event: ExecutionEvent): TaskLogLevel {
  switch (event.type) {
    case "task.failed":
    case "workflow.failed":
      return "error";
    case "memory.warning":
    case "memory.expire":
      return "warn";
    case "task.completed":
    case "workflow.completed":
    case "artifact.created":
      return "success";
    case "memory.archive":
    case "memory.compress":
    case "memory.merge":
    case "memory.write":
    case "memory.after_step":
    case "memory.before_step":
    case "retrieval.performed":
    case "join.completed":
    case "branch.completed":
      return event.status === "fail" ? "error" : "info";
    default:
      return "info";
  }
}
