import { isAbsolute, relative } from "node:path";

import type { ErrorSourceLocation } from "./types.js";

type ErrorStackFrame = {
  functionName?: string;
  file: string;
  line: number;
  column: number;
  raw: string;
};

function normalizeStackPath(file: string): string {
  if (file.startsWith("file://")) {
    try {
      return decodeURIComponent(new URL(file).pathname);
    } catch {
      return file.slice("file://".length);
    }
  }

  return file;
}

function parseStackFrame(line: string): ErrorStackFrame | undefined {
  const directMatch = /^\s*at (.+?):(\d+):(\d+)$/u.exec(line);
  if (directMatch) {
    const [, file, lineNumber, columnNumber] = directMatch;
    if (!file || !lineNumber || !columnNumber) {
      return undefined;
    }
    return {
      file: normalizeStackPath(file),
      line: Number.parseInt(lineNumber, 10),
      column: Number.parseInt(columnNumber, 10),
      raw: line.trim()
    };
  }

  const namedMatch = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/u.exec(line);
  if (!namedMatch) {
    return undefined;
  }

  const [, functionName, file, lineNumber, columnNumber] = namedMatch;
  if (!file || !lineNumber || !columnNumber) {
    return undefined;
  }
  return {
    ...(functionName ? { functionName } : {}),
    file: normalizeStackPath(file),
    line: Number.parseInt(lineNumber, 10),
    column: Number.parseInt(columnNumber, 10),
    raw: line.trim()
  };
}

function isInternalFrame(frame: ErrorStackFrame): boolean {
  const file = frame.file;
  return (
    file.startsWith("node:") ||
    file.startsWith("internal/") ||
    file === "<anonymous>" ||
    file.includes("/node_modules/")
  );
}

function displayFile(file: string): string {
  if (!isAbsolute(file)) {
    return file;
  }

  const relativePath = relative(process.cwd(), file);
  if (!relativePath || relativePath.startsWith("..")) {
    return file;
  }

  return relativePath;
}

export function formatErrorSourceLocation(location: ErrorSourceLocation): string {
  return `${displayFile(location.file)}:${location.line}${
    location.column !== undefined ? `:${location.column}` : ""
  }${
    location.functionName ? ` ${location.functionName}` : ""
  }`;
}

export function parseErrorStackFrames(stack: string | undefined): ErrorStackFrame[] {
  if (typeof stack !== "string") {
    return [];
  }

  return stack
    .split("\n")
    .slice(1)
    .map((line) => parseStackFrame(line))
    .filter((frame): frame is ErrorStackFrame => frame !== undefined);
}

export function extractSourceLocationFromStack(
  stack: string | undefined
): ErrorSourceLocation | undefined {
  const frames = parseErrorStackFrames(stack);
  if (frames.length === 0) {
    return undefined;
  }

  const preferred =
    frames.find(
      (frame) =>
        !isInternalFrame(frame) &&
        typeof frame.functionName === "string" &&
        /(?:^|[.\s])run$/u.test(frame.functionName)
    ) ??
    frames.find((frame) => !isInternalFrame(frame)) ??
    frames.find((frame) => !frame.file.startsWith("node:") && !frame.file.startsWith("internal/")) ??
    frames[0];
  if (!preferred) {
    return undefined;
  }

  const location: ErrorSourceLocation = {
    file: preferred.file,
    line: preferred.line,
    column: preferred.column,
    ...(preferred.functionName ? { functionName: preferred.functionName } : {}),
    display: ""
  };
  location.display = formatErrorSourceLocation(location);
  return location;
}

export function extractSourceLocationFromErrorDetails(
  details: unknown
): ErrorSourceLocation | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }

  const sourceLocation =
    "sourceLocation" in details ? (details as { sourceLocation?: unknown }).sourceLocation : undefined;
  if (
    sourceLocation &&
    typeof sourceLocation === "object" &&
    !Array.isArray(sourceLocation) &&
    "file" in sourceLocation &&
    "line" in sourceLocation
  ) {
    const normalized: ErrorSourceLocation = {
      file: String((sourceLocation as { file: unknown }).file),
      line: Number((sourceLocation as { line: unknown }).line),
      ...(("column" in sourceLocation &&
        typeof (sourceLocation as { column?: unknown }).column === "number")
        ? { column: (sourceLocation as { column: number }).column }
        : {}),
      ...(("functionName" in sourceLocation &&
        typeof (sourceLocation as { functionName?: unknown }).functionName === "string")
        ? { functionName: (sourceLocation as { functionName: string }).functionName }
        : {}),
      display:
        typeof (sourceLocation as { display?: unknown }).display === "string"
          ? (sourceLocation as unknown as { display: string }).display
          : ""
    };

    if (!normalized.display) {
      normalized.display = formatErrorSourceLocation(normalized);
    }

    return normalized;
  }

  const stack = "stack" in details ? (details as { stack?: unknown }).stack : undefined;
  if (typeof stack === "string") {
    const fromStack = extractSourceLocationFromStack(stack);
    if (fromStack) {
      return fromStack;
    }
  }

  const cause = "cause" in details ? (details as { cause?: unknown }).cause : undefined;
  return extractSourceLocationFromErrorDetails(cause);
}
