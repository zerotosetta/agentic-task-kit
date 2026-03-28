import { randomUUID } from "node:crypto";

import { createUnavailableAIProvider } from "./ai.js";
import { createObservedArtifactStore, InMemoryArtifactStore } from "./artifacts.js";
import { ExecutionBroadcaster } from "./events.js";
import { createTaskLogger } from "./logging.js";
import { createObservedMemoryStore, InMemoryMemoryStore } from "./memory.js";
import type {
  AIProvider,
  AISession,
  AISessionMessage,
  ArtifactStore,
  Cycle,
  CycleOptions,
  ExecutionFrame,
  ExecutionStatus,
  MemoryPiece,
  MemoryStore,
  ParallelTransition,
  RunOptions,
  TaskResult,
  Transition,
  WorkflowContext,
  WorkflowDefinition
} from "./types.js";

function createSession(
  llmModelId: string,
  embeddingModelId: string,
  messages: AISessionMessage[] = []
): AISession {
  return {
    sessionId: randomUUID(),
    llmModelId,
    embeddingModelId,
    messages: [...messages],
    fork: () => createSession(llmModelId, embeddingModelId, messages)
  };
}

function createFrame(workflowId: string, runId: string, start: string, now: number): ExecutionFrame {
  return {
    workflowId,
    runId,
    currentState: start,
    checkpointSeq: 0,
    startedAt: now,
    updatedAt: now,
    status: "running",
    completedTasks: [],
    failedTasks: [],
    taskResults: {},
    errors: []
  };
}

function resolveTransition(
  transition: Transition | undefined,
  status: string
): string | ParallelTransition | undefined {
  if (!transition) {
    return undefined;
  }

  if (typeof transition === "string") {
    return transition;
  }

  return transition[status] ?? transition.success;
}

function ensureSequentialOnly(next: string | ParallelTransition | undefined): string | undefined {
  if (!next) {
    return undefined;
  }

  if (typeof next === "string") {
    return next;
  }

  throw new Error("Parallel transitions are not implemented in the Foundation MVP.");
}

async function injectRag(
  workflowId: string,
  memory: MemoryStore,
  now: number,
  rag: RunOptions["rag"]
): Promise<void> {
  if (!rag) {
    return;
  }

  for (const [index, document] of rag.entries()) {
    const timestamp = now;
    const piece: MemoryPiece = {
      key: `workflow.${workflowId}.input.rag.${document.id ?? index}`,
      scope: "workflow",
      category: "context",
      description: "RAG document injected at run time",
      keywords: ["rag", "input", ...(document.meta?.keywords as string[] | undefined ?? [])],
      value: {
        text: document.text,
        meta: document.meta ?? {}
      },
      importance: 0.8,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    await memory.put(piece);
  }
}

async function injectMemory(memory: MemoryStore, pieces: RunOptions["memoryInjection"]): Promise<void> {
  if (!pieces) {
    return;
  }

  for (const piece of pieces) {
    await memory.put(piece);
  }
}

class DefaultCycle implements Cycle {
  private readonly workflows = new Map<string, WorkflowDefinition>();
  private readonly aiProvider: AIProvider;
  private readonly memoryStore: MemoryStore;
  private readonly artifactStore: ArtifactStore;
  private readonly broadcaster: ExecutionBroadcaster;
  private readonly now: () => number;
  private readonly llmModelId: string;
  private readonly embeddingModelId: string;

  constructor(options: CycleOptions = {}) {
    this.aiProvider = options.aiProvider ?? createUnavailableAIProvider();
    this.memoryStore = options.memoryStore ?? new InMemoryMemoryStore();
    this.artifactStore = options.artifactStore ?? new InMemoryArtifactStore();
    this.broadcaster = new ExecutionBroadcaster(options.observers ?? []);
    this.now = options.now ?? (() => Date.now());
    this.llmModelId = options.llmModelId ?? this.aiProvider.defaultChatModel ?? "foundation-llm";
    this.embeddingModelId = options.embeddingModelId ?? "foundation-embedding";
  }

  register(key: string, workflow: WorkflowDefinition): void {
    this.workflows.set(key, workflow);
  }

  async run(key: string, input: unknown, options: RunOptions = {}): Promise<{ frame: ExecutionFrame }> {
    const workflow = this.workflows.get(key);
    if (!workflow) {
      throw new Error(`Workflow "${key}" is not registered.`);
    }

    const observers = options.observers ?? [];
    const runBroadcaster = new ExecutionBroadcaster([
      ...this.broadcaster.listObservers(),
      ...observers
    ]);

    await runBroadcaster.start();

    const workflowId = `${workflow.name}-${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID().slice(0, 8)}`;
    const frame = createFrame(workflowId, runId, workflow.start, this.now());
    const memory = createObservedMemoryStore({
      store: this.memoryStore,
      broadcaster: runBroadcaster,
      workflowId,
      runId,
      now: this.now
    });
    const artifacts = createObservedArtifactStore({
      store: this.artifactStore,
      broadcaster: runBroadcaster,
      workflowId,
      runId,
      now: this.now
    });

    await injectRag(workflowId, memory, this.now(), options.rag);
    await injectMemory(memory, options.memoryInjection);

    await runBroadcaster.emit({
      type: "workflow.started",
      timestamp: this.now(),
      workflowId,
      runId,
      summary: `${workflow.name} start=${workflow.start}`
    });

    const endState = workflow.end ?? "end";
    let finalStatus: ExecutionStatus = "success";

    try {
      while (frame.currentState !== endState) {
        const task = workflow.tasks[frame.currentState];
        if (!task) {
          throw new Error(`Task "${frame.currentState}" is not defined in workflow "${workflow.name}".`);
        }

        await runBroadcaster.emit({
          type: "task.queued",
          timestamp: this.now(),
          workflowId,
          runId,
          taskName: task.name,
          summary: `queued ${task.name}`
        });

        await runBroadcaster.emit({
          type: "task.started",
          timestamp: this.now(),
          workflowId,
          runId,
          taskName: task.name,
          summary: `started ${task.name}`
        });

        const log = createTaskLogger({
          broadcaster: runBroadcaster,
          workflowId,
          runId,
          taskName: task.name,
          now: this.now
        });
        const context: WorkflowContext = {
          workflowId,
          runId,
          input,
          session: createSession(this.llmModelId, this.embeddingModelId),
          ai: this.aiProvider,
          memory,
          artifacts,
          log,
          now: this.now
        };

        if (task.before) {
          await task.before(context);
        }

        let result: TaskResult;
        try {
          result = await task.run(context);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result = {
            status: "fail",
            error: {
              message
            }
          };
        }

        if (task.after) {
          await task.after(context, result);
        }

        frame.taskResults[task.name] = result;
        frame.updatedAt = this.now();
        frame.checkpointSeq += 1;

        if (result.status === "fail") {
          frame.failedTasks.push(task.name);
          frame.errors.push(result.error?.message ?? `${task.name} failed`);
          finalStatus = "fail";
          await runBroadcaster.emit({
            type: "task.failed",
            timestamp: this.now(),
            workflowId,
            runId,
            taskName: task.name,
            summary: result.error?.message ?? `failed ${task.name}`,
            status: result.status
          });
        } else {
          frame.completedTasks.push(task.name);
          if (result.status === "retry") {
            await runBroadcaster.emit({
              type: "task.retry_scheduled",
              timestamp: this.now(),
              workflowId,
              runId,
              taskName: task.name,
              summary: `retry scheduled for ${task.name}`,
              status: result.status
            });
          } else {
            await runBroadcaster.emit({
              type: "task.completed",
              timestamp: this.now(),
              workflowId,
              runId,
              taskName: task.name,
              summary: `completed ${task.name}`,
              status: result.status
            });
          }
        }

        const next = ensureSequentialOnly(
          resolveTransition(workflow.transitions[frame.currentState], result.status)
        );
        frame.currentState = next ?? endState;

        if (!next && result.status === "fail") {
          break;
        }
      }

      frame.status = finalStatus;

      if (finalStatus === "fail") {
        await runBroadcaster.emit({
          type: "workflow.failed",
          timestamp: this.now(),
          workflowId,
          runId,
          summary: `${workflow.name} failed`,
          status: finalStatus,
          meta: {
            errors: [...frame.errors]
          }
        });
      } else {
        await runBroadcaster.emit({
          type: "workflow.completed",
          timestamp: this.now(),
          workflowId,
          runId,
          summary: `${workflow.name} completed`,
          status: finalStatus,
          meta: {
            completedTasks: [...frame.completedTasks]
          }
        });
      }

      await runBroadcaster.flush();
      await runBroadcaster.stop(finalStatus);
      return { frame };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      frame.status = "fail";
      frame.errors.push(message);
      frame.updatedAt = this.now();

      await runBroadcaster.emit({
        type: "workflow.failed",
        timestamp: this.now(),
        workflowId,
        runId,
        summary: message,
        status: "fail"
      });
      await runBroadcaster.flush();
      await runBroadcaster.stop("fail");
      return { frame };
    }
  }
}

export function createCycle(options?: CycleOptions): Cycle {
  return new DefaultCycle(options);
}
