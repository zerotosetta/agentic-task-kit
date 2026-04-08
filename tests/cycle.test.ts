import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  createCLIRenderer,
  createCycle,
  createExecutionHistoryTracker,
  createWorkflowInput,
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
      createWorkflowInput({
        text: "Cycle foundation MVP should produce observable workflow results."
      }),
    );

    expect(result.frame.status).toBe("success");
    expect(result.frame.completedTasks).toEqual(["analyze", "publish"]);
    expect(result.memory.records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: `memory.workflow.summary.${result.frame.workflowId}.analyze`
        })
      ])
    );
    expect(result.artifacts.artifacts).toHaveLength(1);
    expect(result.artifacts.artifacts[0]?.name).toBe("report.md");
    expect(new TextDecoder().decode(result.artifacts.artifacts[0]?.bytes)).toContain("# Cycle Report");
    expect(result.history.events.some((event) => event.type === "workflow.started")).toBe(true);
    expect(result.history.events.some((event) => event.type === "workflow.completed")).toBe(true);
    expect(result.history.taskLogs.some((event) => event.message === "Starting analysis")).toBe(true);

    const summary = await memoryEngine.get(
      `memory.workflow.summary.${result.frame.workflowId}.analyze`,
    );
    expect(summary && "contextSummary" in summary.payload).toBe(true);

    const artifacts = await artifactStore.list();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("report.md");

    expect(output).toContain("workflow started");
    expect(output).toContain("[INFO] task analyze Starting analysis");
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
    const result = await cycle.run("failing-report", createWorkflowInput());

    expect(result.frame.status).toBe("fail");
    expect(output).toContain("[ERROR] task.failed failTask Validation mismatch: missing required field");
    expect(output).toContain(
      "[ERROR] workflow failed failing-report failed reason=Validation mismatch: missing required field",
    );
  });

  it("captures task source locations in failure events", async () => {
    class ThrowingLocationTask extends Task {
      name = "throwingLocation";
      memoryPhase = "EXECUTION" as const;
      memoryTaskType = "debug" as const;

      async run(_ctx: WorkflowContext): Promise<TaskResult> {
        throw new Error("Location test failure");
      }
    }

    const ThrowingWorkflow: WorkflowDefinition = {
      name: "throwing-location-workflow",
      start: "throwingLocation",
      end: "end",
      tasks: {
        throwingLocation: new ThrowingLocationTask()
      },
      transitions: {
        throwingLocation: {
          fail: "end"
        }
      }
    };

    const cycle = createCycle();
    cycle.register("throwing-location-workflow", ThrowingWorkflow);
    const result = await cycle.run("throwing-location-workflow", createWorkflowInput());

    const failedEvent = result.history.events.find(
      (event) => event.type === "task.failed" && event.taskName === "throwingLocation"
    );

    expect(failedEvent).toBeDefined();
    expect(failedEvent?.meta?.sourceLocation).toEqual(
      expect.objectContaining({
        functionName: "ThrowingLocationTask.run",
        line: expect.any(Number),
        column: expect.any(Number),
        display: expect.stringContaining("ThrowingLocationTask.run")
      })
    );
  });

  it("cancels active workflows and propagates abort signals into ctx.ai.chat()", async () => {
    let observedSignal: AbortSignal | undefined;

    class BlockingAITask extends Task {
      name = "blockingAI";
      memoryPhase = "EXECUTION" as const;
      memoryTaskType = "workflow" as const;

      async run(ctx: WorkflowContext): Promise<TaskResult> {
        await ctx.ai.chat({
          messages: [
            {
              role: "user",
              content: "Block until cancellation."
            }
          ]
        });

        return {
          status: "success"
        };
      }
    }

    const BlockingWorkflow: WorkflowDefinition = {
      name: "blocking-workflow",
      start: "blockingAI",
      end: "end",
      tasks: {
        blockingAI: new BlockingAITask()
      },
      transitions: {
        blockingAI: {
          success: "end",
          fail: "end"
        }
      }
    };

    const cycle = createCycle({
      aiProvider: {
        provider: "mock-ai",
        defaultChatModel: "mock-model",
        async chat(request) {
          observedSignal = request.http?.signal;
          return await new Promise((_resolve, reject) => {
            request.http?.signal?.addEventListener(
              "abort",
              () => {
                reject(request.http?.signal?.reason);
              },
              { once: true }
            );
          });
        },
        async chatStream() {
          throw new Error("chatStream should not be used in this test");
        }
      }
    });
    cycle.register("blocking-workflow", BlockingWorkflow);

    const runPromise = cycle.run("blocking-workflow", createWorkflowInput());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(cycle.hasActiveRuns()).toBe(true);

    const cancelled = await cycle.cancelActiveRuns("Workflow cancelled by Ctrl+C.");
    const result = await runPromise;

    expect(cancelled).toBe(1);
    expect(observedSignal?.aborted).toBe(true);
    expect(result.frame.status).toBe("fail");
    expect(result.frame.errors).toContain("Workflow cancelled by Ctrl+C.");
    expect(result.frame.taskResults.blockingAI?.error).toEqual(
      expect.objectContaining({
        message: "Workflow cancelled by Ctrl+C.",
        code: "ABORTED"
      })
    );
    expect(cycle.hasActiveRuns()).toBe(false);
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
      createWorkflowInput({
        request: "demo"
      }),
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

  it("supports running sub workflows during task execution with branch tracking", async () => {
    class ChildTask extends Task {
      name = "childTask";
      memoryPhase = "EXECUTION" as const;
      memoryTaskType = "workflow" as const;

      async run(ctx: WorkflowContext): Promise<TaskResult> {
        await ctx.memory.write({
          id: `memory.workflow.summary.${ctx.workflowId}.child`,
          shard: "workflow",
          kind: "summary",
          payload: {
            workflowId: ctx.workflowId,
            currentStep: this.name,
            history: [],
            contextSummary: "child workflow completed"
          },
          description: "Child workflow summary",
          keywords: ["child", "workflow"],
          importance: 0.91,
          workflowId: ctx.workflowId,
          runId: ctx.runId,
          sourceTask: this.name,
          phase: this.memoryPhase,
          taskType: this.memoryTaskType
        });

        const artifact = await ctx.artifacts.create({
          name: "child.txt",
          mimeType: "text/plain",
          bytes: new TextEncoder().encode("child-result")
        });

        return {
          status: "success",
          output: {
            artifactId: artifact.artifactId
          }
        };
      }
    }

    class ParentTask extends Task {
      name = "invokeChild";
      memoryPhase = "EXECUTION" as const;
      memoryTaskType = "workflow" as const;

      async run(ctx: WorkflowContext): Promise<TaskResult> {
        const child = await ctx.runSubWorkflow(
          "child-workflow",
          createWorkflowInput({
            source: "parent"
          }),
          {
            branchId: "branch.child",
            summary: "invoke child workflow"
          }
        );

        return {
          status: "success",
          output: {
            childStatus: child.frame.status,
            childArtifacts: child.artifacts.artifacts.map((artifact) => artifact.name),
            childHistoryTypes: child.history.events.map((event) => event.type)
          }
        };
      }
    }

    const ChildWorkflow: WorkflowDefinition = {
      name: "child-workflow",
      start: "childTask",
      end: "end",
      tasks: {
        childTask: new ChildTask()
      },
      transitions: {
        childTask: {
          success: "end"
        }
      }
    };

    const ParentWorkflow: WorkflowDefinition = {
      name: "parent-workflow",
      start: "invokeChild",
      end: "end",
      tasks: {
        invokeChild: new ParentTask()
      },
      transitions: {
        invokeChild: {
          success: "end"
        }
      }
    };

    const cycle = createCycle();
    cycle.register("child-workflow", ChildWorkflow);
    cycle.register("parent-workflow", ParentWorkflow);

    const result = await cycle.run("parent-workflow", createWorkflowInput());
    const childOutput = result.frame.taskResults.invokeChild?.output as
      | {
          childStatus: string;
          childArtifacts: string[];
          childHistoryTypes: string[];
        }
      | undefined;

    expect(result.frame.status).toBe("success");
    expect(childOutput).toMatchObject({
      childStatus: "success",
      childArtifacts: ["child.txt"]
    });
    expect(childOutput).toHaveProperty("childHistoryTypes");
    expect(childOutput?.childHistoryTypes).toEqual(
      expect.arrayContaining([
        "branch.started",
        "workflow.started",
        "workflow.completed"
      ])
    );
    expect(
      result.history.events.some(
        (event) => event.type === "branch.started" && event.branchId === "branch.child"
      )
    ).toBe(true);
    expect(
      result.history.events.some(
        (event) => event.type === "branch.completed" && event.branchId === "branch.child"
      )
    ).toBe(true);
    expect(
      result.history.events.some(
        (event) =>
          event.type === "workflow.started" &&
          event.meta?.["parentWorkflowId"] === result.frame.workflowId
      )
    ).toBe(true);
  });

  it("tracks execution history in real time through the tracker interface", async () => {
    const tracker = createExecutionHistoryTracker();
    const snapshots: number[] = [];
    const unsubscribe = tracker.subscribe((snapshot) => {
      snapshots.push(snapshot.events.length + snapshot.taskLogs.length);
    });

    const cycle = createCycle({
      observers: [tracker],
      now: (() => {
        let current = 9_000;
        return () => ++current;
      })()
    });
    cycle.register("report", ReportWorkflow);

    const result = await cycle.run(
      "report",
      createWorkflowInput({
        text: "Track workflow execution updates"
      })
    );

    unsubscribe();

    expect(result.frame.status).toBe("success");
    expect(snapshots.length).toBeGreaterThan(1);
    expect(tracker.snapshot().events.some((event) => event.type === "workflow.completed")).toBe(true);
    expect(tracker.snapshot().taskLogs.some((event) => event.message === "Artifact created")).toBe(true);
  });

  it("exposes run-scoped memory stats and flushMemory() on the run result", async () => {
    const memoryEngine = new InMemoryMemoryEngine();
    const cycle = createCycle({
      memoryEngine
    });

    cycle.register("report", ReportWorkflow);
    const result = await cycle.run(
      "report",
      createWorkflowInput({
        text: "Flush scoped memory after run result inspection."
      })
    );

    expect(result.memory.stats.heap.heapUsed).toBeGreaterThan(0);
    expect(result.memory.stats.totalRecords).toBeGreaterThan(0);
    expect(result.memory.stats.byShard.workflow.total).toBeGreaterThan(0);

    const flushReport = await result.flushMemory();
    expect(flushReport.deletedIds.length + flushReport.deletedArchivedIds.length).toBeGreaterThan(0);

    const remainingScoped = await memoryEngine.list({
      workflowId: result.frame.workflowId,
      runId: result.frame.runId
    });
    expect(remainingScoped).toHaveLength(0);
  });
});
