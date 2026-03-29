import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  createCLIRenderer,
  createCycle,
  InMemoryArtifactStore,
  InMemoryMemoryEngine,
  ReportWorkflow,
  Task,
  type TaskResult,
  type WorkflowContext,
  type WorkflowDefinition
} from "../src/index.js";

describe("Cycle foundation MVP", () => {
  it("runs the sample workflow end-to-end", async () => {
    const memoryEngine = new InMemoryMemoryEngine();
    const artifactStore = new InMemoryArtifactStore();
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });

    const renderer = createCLIRenderer({
      enabled: false,
      stream: stream as unknown as NodeJS.WriteStream
    });
    const cycle = createCycle({
      memoryEngine,
      artifactStore,
      observers: [renderer],
      now: (() => {
        let current = 1_000;
        return () => ++current;
      })()
    });

    cycle.register("report", ReportWorkflow);
    const result = await cycle.run(
      "report",
      "Cycle foundation MVP should produce observable workflow results.",
    );

    expect(result.frame.status).toBe("success");
    expect(result.frame.completedTasks).toEqual(["analyze", "publish"]);

    const summary = await memoryEngine.get(
      `memory.workflow.summary.${result.frame.workflowId}.analyze`,
    );
    expect(summary && "contextSummary" in summary.payload).toBe(true);

    const artifacts = await artifactStore.list();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("report.md");

    expect(output).toContain("workflow started");
    expect(output).toContain("task info analyze Starting analysis");
    expect(output).toContain("workflow completed");
    expect(output).not.toContain("task.log");
    expect(output).not.toContain("\u001B[");
  });

  it("prints task failure causes in line mode output", async () => {
    class FailingTask extends Task {
      name = "failTask";
      memoryPhase = "EXECUTION" as const;
      memoryTaskType = "debug" as const;

      async run(_ctx: WorkflowContext): Promise<TaskResult> {
        return {
          status: "fail",
          error: {
            message: "Validation mismatch: missing required field"
          }
        };
      }
    }

    const FailingWorkflow: WorkflowDefinition = {
      name: "failing-report",
      start: "failTask",
      end: "end",
      tasks: {
        failTask: new FailingTask()
      },
      transitions: {
        failTask: {
          fail: "end"
        }
      }
    };

    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });

    const renderer = createCLIRenderer({
      enabled: false,
      stream: stream as unknown as NodeJS.WriteStream
    });
    const cycle = createCycle({
      observers: [renderer],
      now: (() => {
        let current = 5_000;
        return () => ++current;
      })()
    });

    cycle.register("failing-report", FailingWorkflow);
    const result = await cycle.run("failing-report", {});

    expect(result.frame.status).toBe("fail");
    expect(output).toContain("task.failed failTask Validation mismatch: missing required field");
    expect(output).toContain(
      "workflow failed failing-report failed reason=Validation mismatch: missing required field",
    );
  });

  it("applies automatic memory hooks and bootstraps memoryInjection plus rag records", async () => {
    class CaptureUserContextTask extends Task {
      name = "captureUser";
      memoryPhase = "PLANNING" as const;
      memoryTaskType = "user" as const;

      async run(ctx: WorkflowContext): Promise<TaskResult> {
        return {
          status: "success",
          output: {
            routedShards: ctx.memoryContext?.routedShards ?? [],
            hitIds: ctx.memoryContext?.hits.map((hit) => hit.record.id) ?? []
          }
        };
      }
    }

    class CaptureKnowledgeContextTask extends Task {
      name = "captureKnowledge";
      memoryPhase = "PLANNING" as const;
      memoryTaskType = "default" as const;

      async run(ctx: WorkflowContext): Promise<TaskResult> {
        return {
          status: "success",
          output: {
            routedShards: ctx.memoryContext?.routedShards ?? [],
            hitIds: ctx.memoryContext?.hits.map((hit) => hit.record.id) ?? []
          }
        };
      }
    }

    const HookWorkflow: WorkflowDefinition = {
      name: "hook-workflow",
      start: "captureUser",
      end: "end",
      tasks: {
        captureUser: new CaptureUserContextTask(),
        captureKnowledge: new CaptureKnowledgeContextTask()
      },
      transitions: {
        captureUser: {
          success: "captureKnowledge"
        },
        captureKnowledge: {
          success: "end"
        }
      }
    };

    const cycle = createCycle();
    cycle.register("hook-workflow", HookWorkflow);

    const result = await cycle.run(
      "hook-workflow",
      {
        request: "demo"
      },
      {
        memoryInjection: [
          {
            id: "memory.user.summary.hook-user",
            shard: "user",
            kind: "summary",
            payload: {
              userId: "hook-user",
              preferences: ["line output"],
              behaviorPatterns: ["reviews context before execution"],
              lastUpdated: Date.now()
            },
            description: "Hook user memory",
            keywords: ["user", "hook"],
            importance: 0.92,
            phase: "PLANNING",
            taskType: "user",
            sourceTask: "seed.user"
          }
        ],
        rag: [
          {
            id: "hook-runbook",
            text: "Knowledge runbook for hook retrieval",
            meta: {
              keywords: ["knowledge", "hook", "runbook"]
            }
          }
        ]
      }
    );

    expect(result.frame.status).toBe("success");
    expect(result.frame.taskResults.captureUser?.output).toEqual({
      routedShards: ["user"],
      hitIds: expect.arrayContaining(["memory.user.summary.hook-user"])
    });
    expect(result.frame.taskResults.captureKnowledge?.output).toEqual({
      routedShards: ["knowledge"],
      hitIds: expect.arrayContaining([
        expect.stringContaining("memory.knowledge.raw.rag."),
      ])
    });
  });
});
