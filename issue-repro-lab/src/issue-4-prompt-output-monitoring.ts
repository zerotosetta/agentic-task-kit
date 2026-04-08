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
import { createFakeAIProvider } from "./shared/fake-provider.js";
import {
  isDirectExecution,
  printIssueResult,
  type IssueReproResult
} from "./shared/result.js";

class PromptMonitoringTask extends Task {
  name = "promptMonitoring";
  memoryPhase = "EXECUTION" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const prompt =
      "Monitor this prompt and output length for issue 4 reproduction.";

    const response = await ctx.ai.chat({
      messages: [
        {
          role: "developer",
          content: "Return a short acknowledgement."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    });

    return {
      status: "success",
      output: {
        prompt,
        promptLength: prompt.length,
        outputLength: response.outputText.length
      }
    };
  }
}

const workflow: WorkflowDefinition = {
  name: "issue-4-repro",
  start: "promptMonitoring",
  end: "end",
  tasks: {
    promptMonitoring: new PromptMonitoringTask()
  },
  transitions: {
    promptMonitoring: {
      success: "end",
      fail: "end"
    }
  }
};

export async function runIssue4Repro(): Promise<IssueReproResult> {
  const stream = createCaptureWriteStream();
  const renderer = createCLIRenderer({
    mode: "line",
    stream,
    errorStream: stream,
    logLevel: "debug"
  });
  const cycle = createCycle({
    aiProvider: createFakeAIProvider(),
    observers: [renderer]
  });
  cycle.register("issue-4-repro", workflow);

  const result = await cycle.run(
    "issue-4-repro",
    createWorkflowInput({
      requestId: "issue-4"
    })
  );

  const output = stream.text();
  const taskOutput = result.frame.taskResults.promptMonitoring?.output as
    | {
        prompt: string;
        promptLength: number;
        outputLength: number;
      }
    | undefined;
  const reproduced =
    taskOutput !== undefined &&
    (!output.includes(String(taskOutput.promptLength)) ||
      !output.includes(String(taskOutput.outputLength)) ||
      !output.includes("AI chat request") ||
      !output.includes("AI chat response"));

  return {
    issue: 4,
    title: "동작 모니터링을 위한 입력한 프롬프트와 출력된 내용에 대한 길이 출력 필요",
    reproduced,
    rootCause:
      "기존 원인은 `ctx.ai.chat()` 경로에 prompt/output monitoring 이 자동으로 연결돼 있지 않고, line renderer 도 task log meta 값을 출력하지 않았기 때문이다. 현재는 AI wrapper 가 prompt/output 길이를 structured task log 로 자동 emit 하고 renderer 가 meta 를 line output 에 노출한다.",
    evidence: {
      rendererOutput: output.trim(),
      taskOutput
    }
  };
}

if (isDirectExecution(import.meta.url)) {
  const result = await runIssue4Repro();
  printIssueResult(result);
}
