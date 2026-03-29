import { randomUUID } from "node:crypto";

import { createUnavailableAIProvider } from "./ai.js";
import { createObservedArtifactStore, InMemoryArtifactStore } from "./artifacts.js";
import { ExecutionBroadcaster } from "./events.js";
import { createTaskLogger } from "./logging.js";
import {
  createObservedMemoryEngine,
  InMemoryGraphStore,
  InMemoryKVStore,
  InMemoryMemoryEngine,
  InMemoryVectorStore
} from "./memory.js";
import type {
  AIProvider,
  AISession,
  AISessionMessage,
  ArtifactStore,
  Cycle,
  CycleOptions,
  ExecutionFrame,
  ExecutionStatus,
  MemoryRecordInput,
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
  messages: AISessionMessage[] = [],
): AISession {
  return {
    sessionId: randomUUID(),
    llmModelId,
    embeddingModelId,
    messages: [...messages],
    fork: () => createSession(llmModelId, embeddingModelId, messages)
  };
}

function createFrame(
  workflowId: string,
  runId: string,
  start: string,
  now: number,
): ExecutionFrame {
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
  status: string,
): string | ParallelTransition | undefined {
  if (!transition) {
    return undefined;
  }

  if (typeof transition === "string") {
    return transition;
  }

  return transition[status] ?? transition.success;
}

function ensureSequentialOnly(
  next: string | ParallelTransition | undefined,
): string | undefined {
  if (!next) {
    return undefined;
  }

  if (typeof next === "string") {
    return next;
  }

  throw new Error("Parallel transitions are not implemented in the Foundation MVP.");
}

function toRagMemoryRecord(
  workflowId: string,
  runId: string,
  now: number,
  document: { id?: string; text: string; meta?: Record<string, unknown> },
  index: number,
): MemoryRecordInput {
  return {
    id: `memory.knowledge.raw.rag.${workflowId}.${document.id ?? index}`,
    shard: "knowledge",
    kind: "raw",
    payload: {
      id: document.id ?? `rag-${index}`,
      content: document.text,
      embedding: [],
      tags: (document.meta?.keywords as string[] | undefined) ?? ["rag", "input"]
    },
    description: "RAG document injected at run time",
    keywords: ["rag", "input", ...(((document.meta?.keywords as string[] | undefined) ?? []))],
    importance: 0.85,
    workflowId,
    runId,
    phase: "PLANNING",
    taskType: "default",
    sourceTask: "run.bootstrap"
  };
}

async function injectRag(
  workflowId: string,
  runId: string,
  memory: NonNullable<CycleOptions["memoryEngine"]> | WorkflowContext["memory"],
  now: number,
  rag: RunOptions["rag"],
): Promise<void> {
  if (!rag) {
    return;
  }

  for (const [index, document] of rag.entries()) {
    await memory.write(toRagMemoryRecord(workflowId, runId, now, document, index));
  }
}

async function injectMemory(
  memory: NonNullable<CycleOptions["memoryEngine"]> | WorkflowContext["memory"],
  pieces: RunOptions["memoryInjection"],
): Promise<void> {
  if (!pieces) {
    return;
  }

  for (const piece of pieces) {
    await memory.write(piece);
  }
}

class DefaultCycle implements Cycle {
  private readonly workflows = new Map<string, WorkflowDefinition>();
  private readonly aiProvider: AIProvider;
  private readonly memoryEngine: NonNullable<CycleOptions["memoryEngine"]>;
  private readonly artifactStore: ArtifactStore;
  private readonly broadcaster: ExecutionBroadcaster;
  private readonly now: () => number;
  private readonly llmModelId: string;
  private readonly embeddingModelId: string;

  constructor(options: CycleOptions = {}) {
    this.aiProvider = options.aiProvider ?? createUnavailableAIProvider();
    this.memoryEngine =
      options.memoryEngine ??
      new InMemoryMemoryEngine({
        kvStore: options.kvStore ?? new InMemoryKVStore(),
        vectorStore: options.vectorStore ?? new InMemoryVectorStore(),
        graphStore: options.graphStore ?? new InMemoryGraphStore(),
        ...(options.embeddingProvider ? { embeddingProvider: options.embeddingProvider } : {}),
        ...(options.maxMemoryContextTokens
          ? { maxContextTokens: options.maxMemoryContextTokens }
          : {})
      });
    this.artifactStore = options.artifactStore ?? new InMemoryArtifactStore();
    this.broadcaster = new ExecutionBroadcaster(options.observers ?? []);
    this.now = options.now ?? (() => Date.now());
    this.llmModelId =
      options.llmModelId ?? this.aiProvider.defaultChatModel ?? "foundation-llm";
    this.embeddingModelId = options.embeddingModelId ?? "foundation-embedding";
  }

  register(key: string, workflow: WorkflowDefinition): void {
    this.workflows.set(key, workflow);
  }

  async run(
    key: string,
    input: unknown,
    options: RunOptions = {},
  ): Promise<{ frame: ExecutionFrame }> {
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
    const memory = createObservedMemoryEngine({
      engine: this.memoryEngine,
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

    await injectRag(workflowId, runId, memory, this.now(), options.rag);
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
          throw new Error(
            `Task "${frame.currentState}" is not defined in workflow "${workflow.name}".`,
          );
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
        const memoryContext = await memory.beforeStep({
          workflowId,
          runId,
          currentStep: frame.currentState,
          taskName: task.name,
          taskType: task.memoryTaskType,
          phase: task.memoryPhase,
          input,
          now: this.now()
        });

        const context: WorkflowContext = {
          workflowId,
          runId,
          input,
          session: createSession(this.llmModelId, this.embeddingModelId),
          ai: this.aiProvider,
          memory,
          memoryContext,
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

        await memory.afterStep({
          workflowId,
          runId,
          currentStep: frame.currentState,
          taskName: task.name,
          taskType: task.memoryTaskType,
          phase: task.memoryPhase,
          input,
          result,
          now: this.now()
        });

        frame.taskResults[task.name] = result;
        frame.updatedAt = this.now();
        frame.checkpointSeq += 1;

        if (result.status === "fail") {
          const errorMessage = result.error?.message ?? `${task.name} failed`;
          frame.failedTasks.push(task.name);
          frame.errors.push(errorMessage);
          finalStatus = "fail";
          await runBroadcaster.emit({
            type: "task.failed",
            timestamp: this.now(),
            workflowId,
            runId,
            taskName: task.name,
            summary: errorMessage,
            status: result.status,
            meta: {
              errorMessage,
              ...(result.error?.code ? { errorCode: result.error.code } : {}),
              ...(result.error?.details !== undefined
                ? { errorDetails: result.error.details }
                : {})
            }
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
          resolveTransition(workflow.transitions[frame.currentState], result.status),
        );
        frame.currentState = next ?? endState;

        if (!next && result.status === "fail") {
          break;
        }
      }

      await memory.runLifecycle(this.now());
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
            errors: [...frame.errors],
            errorMessage: frame.errors[frame.errors.length - 1]
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
        status: "fail",
        meta: {
          errorMessage: message
        }
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
