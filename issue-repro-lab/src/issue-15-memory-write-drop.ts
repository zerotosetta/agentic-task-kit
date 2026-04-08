import {
  Task,
  createCycle,
  createWorkflowInput,
  getWorkflowInputValue,
  type TaskResult,
  type WorkflowContext,
  type WorkflowDefinition
} from "../../dist/index.js";

import {
  isDirectExecution,
  printIssueResult,
  type IssueReproResult
} from "./shared/result.js";

const LARGE_CONTEXT_BLOCK = "repeated-memory-block ".repeat(40_000);
type MemoryWriteDisposition = Awaited<ReturnType<WorkflowContext["memory"]["write"]>>;

class RepeatedMemoryWriteTask extends Task {
  name = "repeatedMemoryWrite";
  memoryPhase = "EXECUTION" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const heapBefore = process.memoryUsage().heapUsed;
    const dispositions: MemoryWriteDisposition[] = [];
    const similarWriteAction = getWorkflowInputValue(ctx.input, "similarWriteAction");

    for (let index = 0; index < 8; index += 1) {
      dispositions.push(
        await ctx.memory.write({
          shard: "workflow",
          kind: "raw",
          payload: {
            workflowId: ctx.workflowId,
            currentStep: `${this.name}-${index}`,
            history: [],
            contextSummary: LARGE_CONTEXT_BLOCK
          },
          description: "Repeated workflow memory block for issue 15 reproduction",
          keywords: ["memory", "workflow", "repeated", "issue-15"],
          workflowId: ctx.workflowId,
          runId: ctx.runId,
          sourceTask: this.name,
          phase: this.memoryPhase,
          taskType: this.memoryTaskType,
          ...(typeof similarWriteAction === "string"
            ? { similarWriteAction: similarWriteAction as "overwrite" | "merge" | "discard" }
            : {})
        })
      );
    }

    const heapAfter = process.memoryUsage().heapUsed;
    const records = await ctx.memory.list({
      shard: "workflow",
      archived: false
    });
    const visibleIds = records
      .filter((record: (typeof records)[number]) => record.workflowId === ctx.workflowId)
      .map((record: (typeof records)[number]) => record.id);

    return {
      status: "success",
      output: {
        heapBefore,
        heapAfter,
        dispositions,
        visibleIds
      }
    };
  }
}

const workflow: WorkflowDefinition = {
  name: "issue-15-repro",
  start: "repeatedMemoryWrite",
  end: "end",
  tasks: {
    repeatedMemoryWrite: new RepeatedMemoryWriteTask()
  },
  transitions: {
    repeatedMemoryWrite: {
      success: "end",
      fail: "end"
    }
  }
};

async function executeIssue15Run(input: Record<string, unknown>) {
  const cycle = createCycle();
  cycle.register("issue-15-repro", workflow);

  const result = await cycle.run("issue-15-repro", createWorkflowInput(input));
  const output = result.frame.taskResults.repeatedMemoryWrite?.output as
    | {
        heapBefore: number;
        heapAfter: number;
        dispositions: MemoryWriteDisposition[];
        visibleIds: string[];
      }
    | undefined;
  const warningEvents = result.history.events.filter((event) => event.type === "memory.warning");

  return {
    output,
    warningCodes: warningEvents
      .map((event) => event.meta?.code)
      .filter((value): value is string => typeof value === "string")
  };
}

export async function runIssue15Repro(): Promise<IssueReproResult> {
  const defaultRun = await executeIssue15Run({
    requestId: "issue-15-default"
  });
  const configuredDiscardRun = await executeIssue15Run({
    requestId: "issue-15-discard",
    similarWriteAction: "discard"
  });
  const defaultDiscardCount =
    defaultRun.output?.dispositions.filter((entry: MemoryWriteDisposition) => entry.action === "discard").length ?? 0;
  const configuredDiscardCount =
    configuredDiscardRun.output?.dispositions.filter((entry: MemoryWriteDisposition) => entry.action === "discard").length ?? 0;

  return {
    issue: 15,
    title: "Workflow Context 메모리에 데이터 추가 안되는 현상",
    reproduced:
      defaultRun.output !== undefined &&
      defaultDiscardCount > 0 &&
      defaultRun.output.heapAfter > defaultRun.output.heapBefore,
    rootCause:
      "기존 원인은 heap 부족이 아니라 memory write heuristic 문제였다. 유사한 large record 를 반복 저장하면 novelty 가 급격히 낮아지고, importance 가 0.6 미만으로 떨어져 `write()` 가 조용히 `discard` 를 반환했다. 현재 기본 동작은 overwrite 로 수정됐고, discard 는 명시적인 similar-write policy 로만 발생한다.",
    evidence: {
      defaultHeapBefore: defaultRun.output?.heapBefore,
      defaultHeapAfter: defaultRun.output?.heapAfter,
      defaultDispositions: defaultRun.output?.dispositions,
      defaultVisibleIds: defaultRun.output?.visibleIds,
      defaultWarningCodes: defaultRun.warningCodes,
      configuredDiscardDispositions: configuredDiscardRun.output?.dispositions,
      configuredDiscardVisibleIds: configuredDiscardRun.output?.visibleIds,
      configuredDiscardWarningCodes: configuredDiscardRun.warningCodes,
      configuredDiscardCount
    }
  };
}

if (isDirectExecution(import.meta.url)) {
  const result = await runIssue15Repro();
  printIssueResult(result);
}
