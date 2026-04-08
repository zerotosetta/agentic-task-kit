import {
  Task,
  createCycle,
  createWorkflowInput,
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
          taskType: this.memoryTaskType
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

export async function runIssue15Repro(): Promise<IssueReproResult> {
  const cycle = createCycle();
  cycle.register("issue-15-repro", workflow);

  const result = await cycle.run(
    "issue-15-repro",
    createWorkflowInput({
      requestId: "issue-15"
    })
  );

  const output = result.frame.taskResults.repeatedMemoryWrite?.output as
    | {
        heapBefore: number;
        heapAfter: number;
        dispositions: MemoryWriteDisposition[];
        visibleIds: string[];
      }
    | undefined;
  const discardCount =
    output?.dispositions.filter((entry: MemoryWriteDisposition) => entry.action === "discard").length ?? 0;

  return {
    issue: 15,
    title: "Workflow Context 메모리에 데이터 추가 안되는 현상",
    reproduced:
      output !== undefined &&
      discardCount > 0 &&
      output.heapAfter > output.heapBefore,
    rootCause:
      "heap 부족이 아니라 memory write heuristic 문제다. 유사한 large record 를 반복 저장하면 novelty 가 급격히 낮아지고, importance 가 0.6 미만으로 떨어져 `write()` 가 예외 없이 `discard` 를 반환한다. 호출자가 disposition 을 확인하지 않으면 정상 저장처럼 보인다.",
    evidence: {
      heapBefore: output?.heapBefore,
      heapAfter: output?.heapAfter,
      dispositions: output?.dispositions,
      visibleIds: output?.visibleIds
    }
  };
}

if (isDirectExecution(import.meta.url)) {
  const result = await runIssue15Repro();
  printIssueResult(result);
}
