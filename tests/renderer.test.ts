import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it } from "vitest";

import { createCLIRenderer } from "../src/index.js";
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
      message: "Starting analysis"
    };

    renderer.onEvent(started);
    renderer.onTaskLog?.(log);
    renderer.stop("success");

    expect(output).toContain("workflow started");
    expect(output).toContain("task info analyze Starting analysis");
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
});
