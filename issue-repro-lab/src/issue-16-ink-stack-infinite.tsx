import React from "react";
import { render } from "ink-testing-library";

import { InkRendererScreen } from "../../src/ink-renderer.tsx";
import {
  createInitialRendererState,
  type WorkflowRenderState
} from "../../src/renderer-model.ts";

import {
  isDirectExecution,
  printIssueResult,
  type IssueReproResult
} from "./shared/result.js";

export function runIssue16Repro(): IssueReproResult {
  const state = createInitialRendererState();
  const now = Date.now();
  const workflowId = "workflow-root";

  const workflow: WorkflowRenderState = {
    workflowId,
    runId: "run-root",
    name: "workflow-root",
    summary: "workflow-root start=loop",
    status: "running",
    startedAt: now,
    updatedAt: now,
    taskOrder: [],
    tasks: new Map(),
    branchOrder: ["branch.loop"],
    branches: new Map([
      [
        "branch.loop",
        {
          branchId: "branch.loop",
          summary: "recursive child",
          status: "success",
          startedAt: now,
          completedAt: now,
          childWorkflowId: workflowId,
          childRunId: "run-root"
        }
      ]
    ])
  };

  state.workflowId = workflowId;
  state.runId = "run-root";
  state.status = "running";
  state.updatedAt = now;
  state.workflowOrder.push(workflowId);
  state.workflows.set(workflowId, workflow);

  const warnings: string[] = [];
  const originalConsoleError = console.error;
  let error: unknown;
  let frame = "";
  try {
    console.error = (...args: unknown[]) => {
      warnings.push(args.map((value) => String(value)).join(" "));
    };
    const instance = render(
      <InkRendererScreen
        state={state}
        columns={120}
        rows={40}
        finalStatus={undefined}
      />
    );
    frame = instance.lastFrame() ?? "";
    instance.unmount();
  } catch (caught) {
    error = caught;
  } finally {
    console.error = originalConsoleError;
  }

  const message = error instanceof Error ? error.message : String(error);
  const workflowOccurrences = frame.split("workflow-root [RUNNING").length - 1;
  const duplicateKeyWarnings = warnings.filter((warning) =>
    warning.includes("Encountered two children with the same key")
  );

  return {
    issue: 16,
    title: "Ink rendering: workflow chart is stack infinite",
    reproduced:
      workflowOccurrences > 1 ||
      duplicateKeyWarnings.length > 0 ||
      error instanceof RangeError ||
      message.includes("Maximum call stack size exceeded"),
    rootCause:
      "`renderWorkflowBranchLines()` 가 child workflow recursion 에 대해 visited guard 를 두지 않아 cyclic workflow graph state 가 들어오면 같은 workflow chart 가 끝없이 중첩되고, 상황에 따라 duplicate key warning 또는 stack overflow 로 이어진다.",
    evidence: {
      frame,
      workflowOccurrences,
      duplicateKeyWarnings,
      errorName: error instanceof Error ? error.name : typeof error,
      message
    }
  };
}

if (isDirectExecution(import.meta.url)) {
  const result = runIssue16Repro();
  printIssueResult(result);
}
