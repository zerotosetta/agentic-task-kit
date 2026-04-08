import {
  Task,
  createCLIRenderer,
  createCycle,
  createWorkflowInput,
  type TaskResult,
  type WorkflowContext,
  type WorkflowDefinition
} from "../../dist/index.js";

import { createCaptureWriteStream } from "./shared/capture-stream.js";
import {
  isDirectExecution,
  printIssueResult,
  type IssueReproResult
} from "./shared/result.js";

class ThrowingTask extends Task {
  name = "explode";
  memoryPhase = "EXECUTION" as const;
  memoryTaskType = "workflow" as const;

  async run(_ctx: WorkflowContext): Promise<TaskResult> {
    const error = new Error("boom for issue 17");
    error.stack = [
      "Error: boom for issue 17",
      "    at ThrowingTask.run (issue-17-stack-trace-hidden.ts:17:11)",
      "    at demoFrame (issue-17-stack-trace-hidden.ts:99:3)"
    ].join("\n");
    throw error;
  }
}

const workflow: WorkflowDefinition = {
  name: "issue-17-repro",
  start: "explode",
  end: "end",
  tasks: {
    explode: new ThrowingTask()
  },
  transitions: {
    explode: {
      success: "end",
      fail: "end"
    }
  }
};

export async function runIssue17Repro(): Promise<IssueReproResult> {
  const stream = createCaptureWriteStream();
  const renderer = createCLIRenderer({
    mode: "line",
    stream,
    errorStream: stream,
    logLevel: "debug"
  });
  const cycle = createCycle({
    observers: [renderer]
  });
  cycle.register("issue-17-repro", workflow);

  const result = await cycle.run(
    "issue-17-repro",
    createWorkflowInput({
      requestId: "issue-17"
    })
  );

  const output = stream.text();
  const details =
    result.frame.taskResults.explode?.error?.details as
      | { stack?: string; message?: string }
      | undefined;

  return {
    issue: 17,
    title: "No print stack trace about workflow task error",
    reproduced:
      typeof details?.stack === "string" &&
      !output.includes("demoFrame") &&
      !output.includes("ThrowingTask.run"),
    rootCause:
      "task failure 시 stack trace 는 `result.error.details.stack` 에 보존되지만, line/compact/Ink renderer 가 failure summary 만 출력하고 `errorDetails.stack` 을 화면에 내보내지 않는다.",
    evidence: {
      rendererOutput: output.trim(),
      stackPreview: details?.stack
    }
  };
}

if (isDirectExecution(import.meta.url)) {
  const result = await runIssue17Repro();
  printIssueResult(result);
}
