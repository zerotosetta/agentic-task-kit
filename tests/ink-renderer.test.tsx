import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";

import {
  InkRendererScreen,
  reduceInkUIState,
  type InkUIState
} from "../src/ink-renderer.js";
import {
  createInitialRendererState,
  pushDebugLogLine,
  pushTaskLog,
  reduceExecutionEvent
} from "../src/renderer-model.js";
import type { RendererState } from "../src/renderer-model.js";

async function flushInk(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function createInkState(): RendererState {
  const state = createInitialRendererState();

  reduceExecutionEvent(state, {
    type: "workflow.started",
    timestamp: Date.UTC(2026, 2, 29, 9, 0, 0),
    workflowId: "java-modernization",
    runId: "run_ink",
    summary: "java modernization start=analyze"
  }, 10, 64, 128);

  for (let index = 1; index <= 8; index += 1) {
    reduceExecutionEvent(state, {
      type: "task.started",
      timestamp: Date.UTC(2026, 2, 29, 9, 0, index),
      workflowId: "java-modernization",
      runId: "run_ink",
      taskName: `task-${index}`,
      summary: `history-item-${index}`
    }, 10, 64, 128);

    if (index < 8) {
      reduceExecutionEvent(state, {
        type: "task.completed",
        timestamp: Date.UTC(2026, 2, 29, 9, 0, index) + 800,
        workflowId: "java-modernization",
        runId: "run_ink",
        taskName: `task-${index}`,
        summary: `history-item-${index}-done`,
        status: "success"
      }, 10, 64, 128);
    }
  }

  reduceExecutionEvent(state, {
    type: "branch.started",
    timestamp: Date.UTC(2026, 2, 29, 9, 0, 20),
    workflowId: "java-modernization",
    runId: "run_ink",
    branchId: "branch.refactor",
    summary: "invoke child workflow",
    meta: {
      subWorkflowKey: "child-refactor"
    }
  }, 10, 64, 128);

  reduceExecutionEvent(state, {
    type: "workflow.started",
    timestamp: Date.UTC(2026, 2, 29, 9, 0, 21),
    workflowId: "child-refactor-aa11bb22",
    runId: "run_child",
    summary: "child refactor start=scan",
    meta: {
      parentWorkflowId: "java-modernization",
      parentRunId: "run_ink",
      branchId: "branch.refactor"
    }
  }, 10, 64, 128);

  reduceExecutionEvent(state, {
    type: "task.started",
    timestamp: Date.UTC(2026, 2, 29, 9, 0, 22),
    workflowId: "child-refactor-aa11bb22",
    runId: "run_child",
    taskName: "scan",
    summary: "child-start",
    meta: {
      parentWorkflowId: "java-modernization",
      parentRunId: "run_ink",
      branchId: "branch.refactor"
    }
  }, 10, 64, 128);

  reduceExecutionEvent(state, {
    type: "task.completed",
    timestamp: Date.UTC(2026, 2, 29, 9, 0, 24),
    workflowId: "child-refactor-aa11bb22",
    runId: "run_child",
    taskName: "scan",
    summary: "child-done",
    status: "success",
    meta: {
      parentWorkflowId: "java-modernization",
      parentRunId: "run_ink",
      branchId: "branch.refactor"
    }
  }, 10, 64, 128);

  reduceExecutionEvent(state, {
    type: "workflow.completed",
    timestamp: Date.UTC(2026, 2, 29, 9, 0, 25),
    workflowId: "child-refactor-aa11bb22",
    runId: "run_child",
    summary: "child refactor completed",
    status: "success",
    meta: {
      parentWorkflowId: "java-modernization",
      parentRunId: "run_ink",
      branchId: "branch.refactor"
    }
  }, 10, 64, 128);

  reduceExecutionEvent(state, {
    type: "branch.completed",
    timestamp: Date.UTC(2026, 2, 29, 9, 0, 26),
    workflowId: "java-modernization",
    runId: "run_ink",
    branchId: "branch.refactor",
    summary: "invoke child workflow",
    status: "success",
    meta: {
      childWorkflowId: "child-refactor-aa11bb22",
      childRunId: "run_child"
    }
  }, 10, 64, 128);

  for (let index = 1; index <= 12; index += 1) {
    pushTaskLog(state, {
      timestamp: Date.UTC(2026, 2, 29, 9, 1, index),
      workflowId: "java-modernization",
      runId: "run_ink",
      taskName: `task-${((index - 1) % 8) + 1}`,
      level: index === 12 ? "success" : "info",
      message: `timeline-log-${index}`
    }, 24, 128);
  }

  pushDebugLogLine(
    state,
    `[cycle:http] {"phase":"request","provider":"gemini","method":"POST","url":"https://generativelanguage.googleapis.com/v1beta/openai/chat/completions","requestId":"req_ink"}`,
    Date.UTC(2026, 2, 29, 9, 2, 0),
    128
  );

  reduceExecutionEvent(state, {
    type: "retrieval.performed",
    timestamp: Date.UTC(2026, 2, 29, 9, 2, 1),
    workflowId: "java-modernization",
    runId: "run_ink",
    summary: "retrieve workflow",
    meta: {
      routedShards: ["workflow", "task"],
      hitCount: 2,
      usedTokens: 48
    }
  }, 10, 64, 128);

  return state;
}

describe("Ink renderer screen", () => {
  it("renders workflow flowchart, branch nesting, task durations, and logs", async () => {
    const state = createInkState();
    const instance = render(
      <InkRendererScreen
        state={state}
        columns={110}
        rows={20}
        finalStatus={undefined}
      />
    );

    try {
      await flushInk();
      const frame = instance.lastFrame();

      expect(frame).toContain("워크플로우 파이프라인 플로우차트");
      expect(frame).toContain("워크플로우 task 실행 이력");
      expect(frame).toContain("실행 로그");
      expect(frame).toContain("java modernization [RUNNING");
      expect(frame).toContain("┌────────────────┐");
      expect(frame).toContain("DONE 800ms");
      expect(frame).toContain("└─ branch.refactor");
      expect(frame).toContain("child refactor [SUCCESS");
      expect(frame).toContain("[REQ] gemini POST");
      expect(frame).toContain("[MEM] retrieve");
    } finally {
      instance.unmount();
    }
  });

  it("supports bottom pane focus changes and scrolling with keyboard input", async () => {
    const state = createInkState();
    const instance = render(
      <InkRendererScreen
        state={state}
        columns={110}
        rows={18}
        finalStatus={undefined}
      />
    );

    try {
      expect(instance.lastFrame()).toContain("history-item-1");

      instance.stdin.write("\t");
      await flushInk();
      expect(instance.lastFrame()).toContain("focus=left");

      instance.stdin.write("j");
      await flushInk();
      expect(instance.lastFrame()).toContain("history-item-3");

      instance.stdin.write("G");
      await flushInk();
      expect(instance.lastFrame()).toContain("history-item-8");

      instance.stdin.write("\t");
      await flushInk();
      expect(instance.lastFrame()).toContain("focus=right");

      instance.stdin.write("k");
      await flushInk();
      expect(instance.lastFrame()).toContain("follow=off");

      instance.stdin.write("G");
      await flushInk();
      expect(instance.lastFrame()).toContain("follow=on");
      expect(instance.lastFrame()).toContain("[REQ] gemini POST");
    } finally {
      instance.unmount();
    }
  });
});

describe("Ink renderer reducer", () => {
  it("handles page, edge, and auto-follow state transitions", () => {
    const metrics = {
      leftMaxScroll: 8,
      rightMaxScroll: 12,
      pageSize: 5
    };
    const initial: InkUIState = {
      focusedPane: "right",
      leftScroll: 3,
      rightScroll: 6,
      rightAutoFollow: false
    };

    const paged = reduceInkUIState(initial, {
      type: "scroll.page",
      delta: -1
    }, metrics);
    expect(paged.rightScroll).toBe(1);
    expect(paged.rightAutoFollow).toBe(false);

    const ended = reduceInkUIState(paged, {
      type: "scroll.end"
    }, metrics);
    expect(ended.rightScroll).toBe(12);
    expect(ended.rightAutoFollow).toBe(true);

    const focusedLeft = reduceInkUIState(ended, {
      type: "focus.toggle"
    }, metrics);
    expect(focusedLeft.focusedPane).toBe("left");

    const resetLeft = reduceInkUIState(focusedLeft, {
      type: "scroll.start"
    }, metrics);
    expect(resetLeft.leftScroll).toBe(0);
  });
});
