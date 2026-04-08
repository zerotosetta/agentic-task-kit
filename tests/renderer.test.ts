import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";

import { createCLIRenderer } from "../src/index.js";
import { InkCLIRenderer } from "../src/ink-renderer.js";
import type { ExecutionEvent, TaskLogEvent } from "../src/index.js";

describe("CLI renderer", () => {
  let stream: PassThrough;
  let output: string;

  beforeEach(() => {
    stream = new PassThrough();
    output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });
  });

  it("falls back to line mode when live rendering is disabled", async () => {
    const renderer = createCLIRenderer({
      enabled: false,
      stream: stream as unknown as NodeJS.WriteStream
    });

    renderer.start();
    const started: ExecutionEvent = {
      type: "workflow.started",
      timestamp: Date.UTC(2026, 2, 28, 12, 0, 1),
      workflowId: "report",
      runId: "run_1",
      summary: "report start=analyze"
    };
    const log: TaskLogEvent = {
      timestamp: Date.UTC(2026, 2, 28, 12, 0, 2),
      workflowId: "report",
      runId: "run_1",
      taskName: "analyze",
      level: "info",
      message: "Starting analysis",
      meta: {
        promptLength: 42,
        prompt: "Monitor this prompt for renderer output."
      }
    };

    renderer.onEvent(started);
    renderer.onTaskLog?.(log);
    renderer.stop("success");

    expect(output).toContain("workflow started");
    expect(output).toContain("[INFO] task analyze Starting analysis");
    expect(output).toContain("promptLength=42");
    expect(output).not.toContain("\u001B[");
  });

  it("uses compact mode redraw when enabled in a tty-like stream", async () => {
    const ttyLike = stream as unknown as NodeJS.WriteStream & { isTTY?: boolean };
    ttyLike.isTTY = true;

    const renderer = createCLIRenderer({
      enabled: true,
      mode: "compact",
      refreshMs: 0,
      stream: ttyLike
    });

    renderer.start();
    renderer.onEvent({
      type: "workflow.started",
      timestamp: 1,
      workflowId: "report",
      runId: "run_2",
      summary: "report start=analyze"
    });
    renderer.onEvent({
      type: "task.started",
      timestamp: 2,
      workflowId: "report",
      runId: "run_2",
      taskName: "analyze",
      summary: "started analyze"
    });
    await renderer.onFlush?.();
    renderer.stop("success");

    expect(output).toContain("Cycle report run=run_2");
    expect(output).toContain("Status:");
  });

  it("shows failure reasons in line mode and compact mode", async () => {
    const lineRenderer = createCLIRenderer({
      enabled: false,
      stream: stream as unknown as NodeJS.WriteStream
    });

    lineRenderer.start();
    lineRenderer.onEvent({
      type: "task.failed",
      timestamp: Date.UTC(2026, 2, 28, 12, 0, 3),
      workflowId: "report",
      runId: "run_3",
      taskName: "generate",
      summary: "Request timed out.",
      status: "fail",
      meta: {
        errorMessage: "Request timed out."
      }
    });
    lineRenderer.stop("fail");

    expect(output).toContain("[ERROR] task.failed generate Request timed out.");

    output = "";
    const ttyLike = stream as unknown as NodeJS.WriteStream & { isTTY?: boolean };
    ttyLike.isTTY = true;
    const compactRenderer = createCLIRenderer({
      enabled: true,
      mode: "compact",
      refreshMs: 0,
      stream: ttyLike
    });

    compactRenderer.start();
    compactRenderer.onEvent({
      type: "workflow.started",
      timestamp: 1,
      workflowId: "report",
      runId: "run_4",
      summary: "report start=generate"
    });
    compactRenderer.onEvent({
      type: "task.failed",
      timestamp: 2,
      workflowId: "report",
      runId: "run_4",
      taskName: "generate",
      summary: "Request timed out.",
      status: "fail",
      meta: {
        errorMessage: "Request timed out."
      }
    });
    compactRenderer.onEvent({
      type: "workflow.failed",
      timestamp: 3,
      workflowId: "report",
      runId: "run_4",
      summary: "report failed",
      status: "fail",
      meta: {
        errors: ["Request timed out."],
        errorMessage: "Request timed out."
      }
    });
    await compactRenderer.onFlush?.();
    compactRenderer.stop("fail");

    expect(output).toContain("Failure: Request timed out.");
  });

  it("prints failure stack traces in line mode", () => {
    const renderer = createCLIRenderer({
      enabled: false,
      stream: stream as unknown as NodeJS.WriteStream
    });

    renderer.start();
    renderer.onEvent({
      type: "task.failed",
      timestamp: Date.UTC(2026, 2, 28, 12, 0, 3),
      workflowId: "report",
      runId: "run_3",
      taskName: "generate",
      summary: "boom",
      status: "fail",
      meta: {
        errorMessage: "boom",
        errorDetails: {
          stack: [
            "Error: boom",
            "    at GenerateTask.run (generate.ts:11:7)",
            "    at demoFrame (demo.ts:24:3)"
          ].join("\n")
        }
      }
    });
    renderer.stop("fail");

    expect(output).toContain(
      "[ERROR] task.failed generate boom at=generate.ts:11:7 GenerateTask.run"
    );
    expect(output).toContain("[ERROR] source generate.ts:11:7 GenerateTask.run");
    expect(output).toContain("[ERROR] stack Error: boom");
    expect(output).toContain("GenerateTask.run");
    expect(output).toContain("demoFrame");
  });

  it("applies configured log colors in line mode", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "cycle-renderer-test-"));
    const configPath = path.join(tempDir, "renderer.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        colors: {
          warn: "magenta"
        }
      })
    );

    try {
      const renderer = createCLIRenderer({
        enabled: false,
        stream: stream as unknown as NodeJS.WriteStream,
        useColor: true,
        colorConfigPath: configPath
      });

      renderer.start();
      renderer.onTaskLog?.({
        timestamp: Date.UTC(2026, 2, 28, 12, 0, 5),
        workflowId: "report",
        runId: "run_warn_color",
        taskName: "generate",
        level: "warn",
        message: "watch color"
      });
      renderer.stop("success");

      expect(output).toContain("\u001B[35m");
      expect(output).toContain("watch color");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("prints memory warning summaries in line mode", () => {
    const renderer = createCLIRenderer({
      enabled: false,
      stream: stream as unknown as NodeJS.WriteStream
    });

    renderer.start();
    renderer.onEvent({
      type: "memory.warning",
      timestamp: Date.UTC(2026, 2, 28, 12, 0, 4),
      workflowId: "report",
      runId: "run_warn",
      summary: "similar_overwrite similar record overwritten at score 0.94",
      meta: {
        code: "similar_overwrite",
        reason: "similar record overwritten at score 0.94"
      }
    });
    renderer.stop("success");

    expect(output).toContain("[WARN] memory.warning similar_overwrite similar record overwritten at score 0.94");
  });

  it("falls back to jsonl when ink mode is requested without an interactive tty", () => {
    const renderer = createCLIRenderer({
      enabled: true,
      mode: "ink",
      stream: stream as unknown as NodeJS.WriteStream
    });

    renderer.start();
    renderer.onEvent({
      type: "workflow.started",
      timestamp: 10,
      workflowId: "report",
      runId: "run_jsonl",
      summary: "report start=analyze"
    });
    renderer.stop("success");

    expect(output).toContain(`"kind":"event"`);
    expect(output).toContain(`"type":"workflow.started"`);
  });

  it("selects the Ink renderer when interactive tty streams are available", () => {
    const ttyLike = stream as unknown as NodeJS.WriteStream & {
      isTTY?: boolean;
      columns?: number;
      rows?: number;
    };
    ttyLike.isTTY = true;
    ttyLike.columns = 100;
    ttyLike.rows = 30;

    const descriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: true
    });

    try {
      const renderer = createCLIRenderer({
        enabled: true,
        mode: "ink",
        stream: ttyLike
      });

      expect(renderer).toBeInstanceOf(InkCLIRenderer);
    } finally {
      if (descriptor) {
        Object.defineProperty(process.stdin, "isTTY", descriptor);
      } else {
        Reflect.deleteProperty(process.stdin, "isTTY");
      }
    }
  });

  it("keeps Ink terminal state after stop until close is called", () => {
    const ttyLike = stream as unknown as NodeJS.WriteStream & {
      isTTY?: boolean;
      columns?: number;
      rows?: number;
      on?: (event: string, listener: (...args: unknown[]) => void) => void;
      off?: (event: string, listener: (...args: unknown[]) => void) => void;
    };
    ttyLike.isTTY = true;
    ttyLike.columns = 100;
    ttyLike.rows = 30;
    ttyLike.on = ((..._args: unknown[]) => ttyLike) as typeof ttyLike.on;
    ttyLike.off = ((..._args: unknown[]) => ttyLike) as typeof ttyLike.off;

    const renderer = new InkCLIRenderer({
      enabled: true,
      mode: "ink",
      persistAfterCompletion: true,
      stream: ttyLike,
      errorStream: ttyLike
    }) as InkCLIRenderer & Record<string, unknown>;

    let leaveCalls = 0;
    let summaryCalls = 0;

    renderer["attachResizeHandler"] = () => undefined;
    renderer["attachDebugStream"] = () => undefined;
    renderer["renderNow"] = () => undefined;
    renderer["enterAlternateScreen"] = () => undefined;
    renderer["leaveAlternateScreen"] = () => {
      leaveCalls += 1;
    };
    renderer["writeFinalSummary"] = () => {
      summaryCalls += 1;
    };

    renderer.start();
    renderer.stop("success");

    expect(leaveCalls).toBe(0);
    expect(summaryCalls).toBe(0);

    renderer.close();

    expect(leaveCalls).toBe(1);
    expect(summaryCalls).toBe(1);
  });

  it("handles Ctrl+C by closing Ink silently and exiting the process", () => {
    const ttyLike = stream as unknown as NodeJS.WriteStream & {
      isTTY?: boolean;
      columns?: number;
      rows?: number;
      on?: typeof stream.on;
      off?: typeof stream.off;
    };
    ttyLike.isTTY = true;
    ttyLike.columns = 100;
    ttyLike.rows = 30;
    ttyLike.on = ((..._args: Parameters<typeof stream.on>) => ttyLike) as typeof ttyLike.on;
    ttyLike.off = ((..._args: Parameters<typeof stream.off>) => ttyLike) as typeof ttyLike.off;

    const renderer = new InkCLIRenderer({
      enabled: true,
      mode: "ink",
      persistAfterCompletion: true,
      stream: ttyLike,
      errorStream: ttyLike,
      workflowController: {
        hasActiveRuns: () => false,
        cancelActiveRuns: async () => 0
      }
    }) as InkCLIRenderer & Record<string, unknown>;

    let leaveCalls = 0;
    let summaryCalls = 0;
    let exitCode: number | undefined;

    renderer["attachResizeHandler"] = () => undefined;
    renderer["attachDebugStream"] = () => undefined;
    renderer["renderNow"] = () => undefined;
    renderer["enterAlternateScreen"] = () => undefined;
    renderer["leaveAlternateScreen"] = () => {
      leaveCalls += 1;
    };
    renderer["writeFinalSummary"] = () => {
      summaryCalls += 1;
    };

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      return undefined as never;
    }) as typeof process.exit;

    try {
      renderer.start();
      const signalHandler = renderer["processSignalHandler"] as (() => void) | undefined;
      signalHandler?.();
    } finally {
      process.exit = originalExit;
    }

    expect(leaveCalls).toBe(1);
    expect(summaryCalls).toBe(0);
    expect(exitCode).toBe(0);
  });

  it("handles Ctrl+C by cancelling active workflows, then restoring the terminal and exiting when the run stops", async () => {
    const ttyLike = stream as unknown as NodeJS.WriteStream & {
      isTTY?: boolean;
      columns?: number;
      rows?: number;
      on?: typeof stream.on;
      off?: typeof stream.off;
    };
    ttyLike.isTTY = true;
    ttyLike.columns = 100;
    ttyLike.rows = 30;
    ttyLike.on = ((..._args: Parameters<typeof stream.on>) => ttyLike) as typeof ttyLike.on;
    ttyLike.off = ((..._args: Parameters<typeof stream.off>) => ttyLike) as typeof ttyLike.off;

    let cancelCalls = 0;
    let leaveCalls = 0;
    let summaryCalls = 0;
    let exitCode: number | undefined;

    const renderer = new InkCLIRenderer({
      enabled: true,
      mode: "ink",
      persistAfterCompletion: true,
      stream: ttyLike,
      errorStream: ttyLike,
      workflowController: {
        hasActiveRuns: () => true,
        cancelActiveRuns: async () => {
          cancelCalls += 1;
          return 1;
        }
      }
    }) as InkCLIRenderer & Record<string, unknown>;

    renderer["attachResizeHandler"] = () => undefined;
    renderer["attachDebugStream"] = () => undefined;
    renderer["renderNow"] = () => undefined;
    renderer["enterAlternateScreen"] = () => undefined;
    renderer["leaveAlternateScreen"] = () => {
      leaveCalls += 1;
    };
    renderer["writeFinalSummary"] = () => {
      summaryCalls += 1;
    };

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      return undefined as never;
    }) as typeof process.exit;

    try {
      renderer.start();
      const signalHandler = renderer["processSignalHandler"] as (() => void) | undefined;
      signalHandler?.();
      await Promise.resolve();
      renderer.stop("fail");
    } finally {
      process.exit = originalExit;
    }

    expect(cancelCalls).toBe(1);
    expect(leaveCalls).toBe(1);
    expect(summaryCalls).toBe(1);
    expect(exitCode).toBe(130);
  });
});
