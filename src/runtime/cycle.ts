import { randomUUID } from "node:crypto";
import { createUnavailableAIProvider } from "../ai.js";
import { createObservedArtifactStore, InMemoryArtifactStore } from "../artifacts.js";
import { extractSourceLocationFromErrorDetails } from "../error-location.js";
import { toWorkflowCancellationError } from "../errors.js";
import { ExecutionBroadcaster } from "../events.js";
import { createExecutionHistoryTracker } from "../history.js";
import { createTaskLogger } from "../logging.js";
import {
  createObservedMemoryEngine,
  InMemoryGraphStore,
  InMemoryKVStore,
  InMemoryMemoryEngine,
  InMemoryVectorStore,
} from "../memory.js";
import { registerGlobalWorkflowRun, WorkflowRunControl } from "../runtime-control.js";
import type {
  AIProvider,
  ArtifactStore,
  Cycle,
  CycleOptions,
  CycleRunResult,
  ExecutionHistoryTracker,
  ExecutionStatus,
  RunArtifact,
  RunOptions,
  SubWorkflowRunOptions,
  WorkflowContext,
  WorkflowDefinition,
  WorkflowInput,
} from "../types.js";
import { createObservedAIProvider } from "./ai-monitoring.js";
import { injectMemory, injectRag } from "./bootstrap.js";
import { createAbortAwareAIProvider } from "./cancellation.js";
import { toSerializableErrorDetails } from "./errors.js";
import { collectRunResultSnapshot, EMPTY_LIFECYCLE_REPORT } from "./result.js";
import { createFrame, createSession, ensureSequentialOnly, resolveTransition } from "./state.js";
import { executeTask } from "./task-execution.js";
import { assertWorkflowInput, validateWorkflow } from "./validation.js";

type ParentRunContext = {
  workflowId: string;
  runId: string;
  branchId?: string;
};

type InternalRunOptions = {
  key: string;
  input: WorkflowInput;
  options?: RunOptions | SubWorkflowRunOptions;
  broadcaster?: ExecutionBroadcaster;
  historyTracker: ExecutionHistoryTracker;
  parent?: ParentRunContext;
  control: WorkflowRunControl;
};

class DefaultCycle implements Cycle {
  private readonly workflows = new Map<string, WorkflowDefinition>();
  private readonly aiProvider: AIProvider;
  private readonly memoryEngine: NonNullable<CycleOptions["memoryEngine"]>;
  private readonly artifactStore: ArtifactStore;
  private readonly broadcaster: ExecutionBroadcaster;
  private readonly now: () => number;
  private readonly llmModelId: string;
  private readonly embeddingModelId: string;
  private readonly activeRuns = new Map<string, WorkflowRunControl>();

  constructor(options: CycleOptions = {}) {
    this.aiProvider = options.aiProvider ?? createUnavailableAIProvider();
    this.memoryEngine =
      options.memoryEngine ??
      new InMemoryMemoryEngine({
        kvStore: options.kvStore ?? new InMemoryKVStore(),
        vectorStore: options.vectorStore ?? new InMemoryVectorStore(),
        graphStore: options.graphStore ?? new InMemoryGraphStore(),
        ...(options.embeddingProvider ? { embeddingProvider: options.embeddingProvider } : {}),
        ...(options.memoryWritePolicy ? { writePolicy: options.memoryWritePolicy } : {}),
        ...(options.maxMemoryContextTokens
          ? { maxContextTokens: options.maxMemoryContextTokens }
          : {}),
      });
    this.artifactStore = options.artifactStore ?? new InMemoryArtifactStore();
    this.broadcaster = new ExecutionBroadcaster(options.observers ?? []);
    this.now = options.now ?? (() => Date.now());
    this.llmModelId = options.llmModelId ?? this.aiProvider.defaultChatModel ?? "foundation-llm";
    this.embeddingModelId = options.embeddingModelId ?? "foundation-embedding";
  }

  register(key: string, workflow: WorkflowDefinition): void {
    validateWorkflow(key, workflow);
    this.workflows.set(key, workflow);
  }

  private requireWorkflow(key: string): WorkflowDefinition {
    const workflow = this.workflows.get(key);
    if (!workflow) throw new Error(`Workflow "${key}" is not registered.`);
    validateWorkflow(key, workflow);
    return workflow;
  }

  hasActiveRuns(): boolean {
    for (const run of this.activeRuns.values()) {
      if (run.isActive()) {
        return true;
      }
    }

    return false;
  }

  async cancelActiveRuns(reason = "Workflow cancelled by Ctrl+C."): Promise<number> {
    let cancelled = 0;
    for (const run of this.activeRuns.values()) {
      if (!run.isActive()) {
        continue;
      }

      if (run.cancel(reason)) {
        cancelled += 1;
      }
    }

    return cancelled;
  }

  async run(key: string, input: WorkflowInput, options: RunOptions = {}): Promise<CycleRunResult> {
    assertWorkflowInput(input);
    this.requireWorkflow(key);
    if (options.durable)
      throw new Error("Durable execution is not implemented in the Foundation MVP.");
    const controlKey = randomUUID();
    const control = new WorkflowRunControl();
    this.activeRuns.set(controlKey, control);
    const unregisterGlobalRun = registerGlobalWorkflowRun(control);

    const historyTracker = createExecutionHistoryTracker();
    const runBroadcaster = new ExecutionBroadcaster([
      ...this.broadcaster.listObservers(),
      ...(options.observers ?? []),
      historyTracker,
    ]);

    let finalStatus: "success" | "fail" | undefined;
    let failure: unknown;
    let failed = false;

    try {
      await runBroadcaster.start();
      const result = await this.runInternal({
        key,
        input,
        options,
        broadcaster: runBroadcaster,
        historyTracker,
        control,
      });
      finalStatus = result.frame.status === "success" ? "success" : "fail";
      return result;
    } catch (error) {
      failed = true;
      failure = error;
      throw error;
    } finally {
      control.complete();
      unregisterGlobalRun();
      this.activeRuns.delete(controlKey);
      try {
        await runBroadcaster.stop(finalStatus);
      } catch (cleanupError) {
        if (failed)
          throw new AggregateError(
            [failure, cleanupError],
            "Workflow execution and observer cleanup both failed.",
          );
        throw cleanupError;
      }
    }
  }

  private async runSubWorkflow(
    parent: ParentRunContext,
    key: string,
    input: WorkflowInput,
    broadcaster: ExecutionBroadcaster,
    control: WorkflowRunControl,
    options: SubWorkflowRunOptions = {},
  ): Promise<CycleRunResult> {
    control.throwIfRequested();
    assertWorkflowInput(input);
    if (options.durable)
      throw new Error("Durable execution is not implemented in the Foundation MVP.");
    this.requireWorkflow(key);
    const branchId = options.branchId ?? `branch_${randomUUID().slice(0, 8)}`;
    const historyTracker = createExecutionHistoryTracker();
    broadcaster.addObserver(historyTracker);

    try {
      await broadcaster.emit({
        type: "branch.started",
        timestamp: this.now(),
        workflowId: parent.workflowId,
        runId: parent.runId,
        branchId,
        summary: options.summary ?? `sub-workflow ${key} started`,
        meta: {
          subWorkflowKey: key,
        },
      });

      const result = await this.runInternal({
        key,
        input,
        options,
        broadcaster,
        historyTracker,
        control,
        parent: {
          ...parent,
          branchId,
        },
      });

      await broadcaster.emit({
        type: "branch.completed",
        timestamp: this.now(),
        workflowId: parent.workflowId,
        runId: parent.runId,
        branchId,
        summary: options.summary ?? `sub-workflow ${key} completed`,
        status: result.frame.status,
        meta: {
          subWorkflowKey: key,
          childWorkflowId: result.frame.workflowId,
          childRunId: result.frame.runId,
        },
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await broadcaster.emit({
        type: "branch.completed",
        timestamp: this.now(),
        workflowId: parent.workflowId,
        runId: parent.runId,
        branchId,
        summary: options.summary ?? `sub-workflow ${key} failed`,
        status: "fail",
        meta: {
          subWorkflowKey: key,
          errorMessage: message,
        },
      });
      throw error;
    } finally {
      broadcaster.removeObserver(historyTracker);
    }
  }

  private async runInternal(args: InternalRunOptions): Promise<CycleRunResult> {
    const workflow = this.requireWorkflow(args.key);
    args.control.throwIfRequested();

    const runBroadcaster = args.broadcaster;
    if (!runBroadcaster) {
      throw new Error("Run broadcaster is required.");
    }

    const workflowId = `${workflow.name}-${randomUUID().slice(0, 8)}`;
    const runId = `run_${randomUUID().slice(0, 8)}`;
    const frame = createFrame(workflowId, runId, workflow.start, this.now());
    const runArtifacts: RunArtifact[] = [];
    const memory = createObservedMemoryEngine({
      engine: this.memoryEngine,
      broadcaster: runBroadcaster,
      workflowId,
      runId,
      now: this.now,
    });
    const artifacts = createObservedArtifactStore({
      store: this.artifactStore,
      broadcaster: runBroadcaster,
      workflowId,
      runId,
      now: this.now,
      onCreate: (artifact) => {
        runArtifacts.push(artifact);
      },
    });
    let lifecycleReport = EMPTY_LIFECYCLE_REPORT;
    const abortAwareAIProvider = createAbortAwareAIProvider(this.aiProvider, args.control.signal);

    const meta = args.parent
      ? {
          parentWorkflowId: args.parent.workflowId,
          parentRunId: args.parent.runId,
          ...(args.parent.branchId ? { branchId: args.parent.branchId } : {}),
        }
      : undefined;

    await injectRag(workflowId, runId, memory, this.now(), args.options?.rag);
    await injectMemory(memory, args.options?.memoryInjection);

    await runBroadcaster.emit({
      type: "workflow.started",
      timestamp: this.now(),
      workflowId,
      runId,
      summary: `${workflow.name} start=${workflow.start}`,
      ...(meta ? { meta } : {}),
    });

    const endState = workflow.end ?? "end";
    let finalStatus: ExecutionStatus = "success";
    let lastErrorDetails: unknown;

    try {
      while (frame.currentState !== endState) {
        args.control.throwIfRequested();
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
          summary: `queued ${task.name}`,
          ...(meta ? { meta } : {}),
        });

        await runBroadcaster.emit({
          type: "task.started",
          timestamp: this.now(),
          workflowId,
          runId,
          taskName: task.name,
          summary: `started ${task.name}`,
          ...(meta ? { meta } : {}),
        });

        const log = createTaskLogger({
          broadcaster: runBroadcaster,
          workflowId,
          runId,
          taskName: task.name,
          ...(args.parent?.branchId ? { branchId: args.parent.branchId } : {}),
          now: this.now,
        });
        const memoryContext = await memory.beforeStep({
          workflowId,
          runId,
          currentStep: frame.currentState,
          taskName: task.name,
          taskType: task.memoryTaskType,
          phase: task.memoryPhase,
          input: args.input,
          now: this.now(),
        });
        args.control.throwIfRequested();

        const context: WorkflowContext = {
          workflowId,
          runId,
          input: args.input,
          session: createSession(this.llmModelId, this.embeddingModelId),
          ai: abortAwareAIProvider,
          memory,
          memoryContext,
          artifacts,
          log,
          cancellation: args.control,
          now: this.now,
          runSubWorkflow: (key, input, options) =>
            this.runSubWorkflow(
              {
                workflowId,
                runId,
              },
              key,
              input,
              runBroadcaster,
              args.control,
              options,
            ),
        };
        context.ai = createObservedAIProvider(abortAwareAIProvider, log);

        const result = await executeTask(task, context, frame.currentState);

        frame.taskResults[task.name] = result;
        frame.updatedAt = this.now();
        frame.checkpointSeq += 1;

        if (result.status === "fail") {
          const errorMessage = result.error?.message ?? `${task.name} failed`;
          lastErrorDetails = result.error?.details;
          const sourceLocation = extractSourceLocationFromErrorDetails(result.error?.details);
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
              ...meta,
              errorMessage,
              ...(sourceLocation ? { sourceLocation } : {}),
              ...(result.error?.code ? { errorCode: result.error.code } : {}),
              ...(result.error?.details !== undefined
                ? { errorDetails: result.error.details }
                : {}),
            },
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
              status: result.status,
              ...(meta ? { meta } : {}),
            });
          } else {
            await runBroadcaster.emit({
              type: "task.completed",
              timestamp: this.now(),
              workflowId,
              runId,
              taskName: task.name,
              summary: `completed ${task.name}`,
              status: result.status,
              ...(meta ? { meta } : {}),
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

      lifecycleReport = await memory.runLifecycle(this.now());
      frame.status = finalStatus;

      if (finalStatus === "fail") {
        const sourceLocation = extractSourceLocationFromErrorDetails(lastErrorDetails);
        await runBroadcaster.emit({
          type: "workflow.failed",
          timestamp: this.now(),
          workflowId,
          runId,
          summary: `${workflow.name} failed`,
          status: finalStatus,
          meta: {
            ...meta,
            errors: [...frame.errors],
            errorMessage: frame.errors[frame.errors.length - 1],
            ...(sourceLocation ? { sourceLocation } : {}),
            ...(lastErrorDetails !== undefined ? { errorDetails: lastErrorDetails } : {}),
          },
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
            ...meta,
            completedTasks: [...frame.completedTasks],
          },
        });
      }

      await runBroadcaster.flush();
      return collectRunResultSnapshot({
        frame,
        memory,
        artifacts: runArtifacts,
        lifecycle: lifecycleReport,
        history: args.historyTracker,
      });
    } catch (error) {
      const normalizedError = args.control.isCancellationRequested()
        ? toWorkflowCancellationError(args.control.reason)
        : error;
      const message =
        normalizedError instanceof Error ? normalizedError.message : String(normalizedError);
      frame.status = "fail";
      frame.errors.push(message);
      frame.updatedAt = this.now();
      lifecycleReport = await memory.runLifecycle(this.now());

      const errorDetails =
        normalizedError instanceof Error ? toSerializableErrorDetails(normalizedError) : undefined;

      await runBroadcaster.emit({
        type: "workflow.failed",
        timestamp: this.now(),
        workflowId,
        runId,
        summary: message,
        status: "fail",
        meta: {
          ...meta,
          errorMessage: message,
          ...(errorDetails !== undefined
            ? { sourceLocation: extractSourceLocationFromErrorDetails(errorDetails) }
            : {}),
          ...(errorDetails !== undefined ? { errorDetails } : {}),
        },
      });
      await runBroadcaster.flush();
      return collectRunResultSnapshot({
        frame,
        memory,
        artifacts: runArtifacts,
        lifecycle: lifecycleReport,
        history: args.historyTracker,
      });
    }
  }
}

export function createCycle(options?: CycleOptions): Cycle {
  return new DefaultCycle(options);
}
