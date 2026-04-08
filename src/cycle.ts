import { randomUUID } from "node:crypto";

import { createUnavailableAIProvider } from "./ai.js";
import { createObservedArtifactStore, InMemoryArtifactStore } from "./artifacts.js";
import { toWorkflowCancellationError } from "./errors.js";
import { ExecutionBroadcaster } from "./events.js";
import { createExecutionHistoryTracker } from "./history.js";
import { createTaskLogger } from "./logging.js";
import {
  createObservedMemoryEngine,
  InMemoryGraphStore,
  InMemoryKVStore,
  InMemoryMemoryEngine,
  InMemoryVectorStore
} from "./memory.js";
import {
  registerGlobalWorkflowRun,
  WorkflowRunControl
} from "./runtime-control.js";
import type {
  AIChatRequest,
  AIChatResponse,
  AIChatStream,
  AIProvider,
  AISession,
  AISessionMessage,
  ArtifactStore,
  Cycle,
  CycleRunResult,
  CycleOptions,
  ExecutionFrame,
  ExecutionHistoryTracker,
  ExecutionStatus,
  LifecycleReport,
  MemoryRecordInput,
  ParallelTransition,
  RunOptions,
  RunArtifact,
  SubWorkflowRunOptions,
  TaskResult,
  Transition,
  WorkflowInput,
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

function combineAbortSignals(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (activeSignals.length === 0) {
    return undefined;
  }

  if (activeSignals.length === 1) {
    return activeSignals[0];
  }

  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(activeSignals);
  }

  const controller = new AbortController();
  const cleanup = (): void => {
    for (const signal of activeSignals) {
      signal.removeEventListener("abort", onAbort);
    }
  };
  const onAbort = (event: Event): void => {
    const signal = event.target as AbortSignal;
    cleanup();
    controller.abort(signal.reason);
  };

  for (const signal of activeSignals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      return controller.signal;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  }

  return controller.signal;
}

function withWorkflowAbortSignal(
  request: AIChatRequest,
  workflowSignal: AbortSignal
): AIChatRequest {
  const signal = combineAbortSignals([workflowSignal, request.http?.signal]);
  if (!signal) {
    return request;
  }

  return {
    ...request,
    http: {
      ...request.http,
      signal
    }
  };
}

function createAbortAwareAIProvider(provider: AIProvider, workflowSignal: AbortSignal): AIProvider {
  return {
    provider: provider.provider,
    defaultChatModel: provider.defaultChatModel,
    chat: (request) => provider.chat(withWorkflowAbortSignal(request, workflowSignal)),
    chatStream: (request) => provider.chatStream(withWorkflowAbortSignal(request, workflowSignal))
  };
}

function clipMonitoringText(value: string, maxLength = 160): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }

        if (entry && typeof entry === "object" && "text" in entry) {
          return String((entry as { text?: unknown }).text ?? "");
        }

        return JSON.stringify(entry);
      })
      .join("\n");
  }

  if (content === undefined || content === null) {
    return "";
  }

  return String(content);
}

function buildPromptMonitoringMeta(provider: AIProvider, request: AIChatRequest): Record<string, unknown> {
  const fullPrompt = request.messages
    .map((message) => `${message.role}: ${stringifyMessageContent(message.content)}`)
    .join("\n");
  const userPrompt = request.messages
    .filter((message) => message.role === "user")
    .map((message) => stringifyMessageContent(message.content))
    .join("\n");
  const prompt = userPrompt || fullPrompt;

  return {
    provider: provider.provider,
    model: request.model ?? provider.defaultChatModel ?? "unconfigured",
    messageCount: request.messages.length,
    promptLength: prompt.length,
    fullPromptLength: fullPrompt.length,
    prompt: clipMonitoringText(prompt)
  };
}

function buildResponseMonitoringMeta(response: AIChatResponse): Record<string, unknown> {
  return {
    provider: response.provider,
    model: response.model,
    outputLength: response.outputText.length,
    output: clipMonitoringText(response.outputText),
    ...(response.finishReason ? { finishReason: response.finishReason } : {}),
    ...(response.usage?.inputTokens !== undefined ? { inputTokens: response.usage.inputTokens } : {}),
    ...(response.usage?.outputTokens !== undefined ? { outputTokens: response.usage.outputTokens } : {}),
    ...(response.usage?.totalTokens !== undefined ? { totalTokens: response.usage.totalTokens } : {})
  };
}

function errorMessageForMonitoring(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function createObservedAIProvider(
  provider: AIProvider,
  log: WorkflowContext["log"]
): AIProvider {
  return {
    provider: provider.provider,
    defaultChatModel: provider.defaultChatModel,
    async chat(request) {
      const requestMeta = buildPromptMonitoringMeta(provider, request);
      log.info("AI chat request", requestMeta);

      try {
        const response = await provider.chat(request);
        log.success("AI chat response", {
          ...requestMeta,
          ...buildResponseMonitoringMeta(response)
        });
        return response;
      } catch (error) {
        log.error("AI chat failed", {
          ...requestMeta,
          errorMessage: errorMessageForMonitoring(error)
        });
        throw error;
      }
    },
    async chatStream(request): Promise<AIChatStream> {
      const requestMeta = buildPromptMonitoringMeta(provider, request);
      log.info("AI chat stream request", requestMeta);

      try {
        const stream = await provider.chatStream(request);
        const finalResponse = stream.finalResponse.then(
          (response) => {
            log.success("AI chat stream response", {
              ...requestMeta,
              ...buildResponseMonitoringMeta(response)
            });
            return response;
          },
          (error) => {
            log.error("AI chat stream failed", {
              ...requestMeta,
              errorMessage: errorMessageForMonitoring(error)
            });
            throw error;
          }
        );

        return {
          async *[Symbol.asyncIterator]() {
            for await (const chunk of stream) {
              yield chunk;
            }
          },
          finalResponse
        };
      } catch (error) {
        log.error("AI chat stream failed", {
          ...requestMeta,
          errorMessage: errorMessageForMonitoring(error)
        });
        throw error;
      }
    }
  };
}

function toSerializableErrorDetails(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string") {
    details.code = code;
  }

  return details;
}

function toFailureResult(error: unknown, control: WorkflowRunControl): TaskResult {
  if (control.isCancellationRequested()) {
    const cancellationError = toWorkflowCancellationError(control.reason);
    return {
      status: "fail",
      error: {
        message: cancellationError.message,
        code: cancellationError.code,
        details: toSerializableErrorDetails(error)
      }
    };
  }

  if (error instanceof Error) {
    return {
      status: "fail",
      error: {
        message: error.message,
        ...(("code" in error && typeof (error as { code?: unknown }).code === "string")
          ? { code: (error as { code: string }).code }
          : {}),
        details: toSerializableErrorDetails(error)
      }
    };
  }

  return {
    status: "fail",
    error: {
      message: String(error)
    }
  };
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

const EMPTY_LIFECYCLE_REPORT: LifecycleReport = {
  archivedIds: [],
  deletedIds: [],
  compressedIds: [],
  expiredIds: []
};

function isRunScopedRecord(
  record: { workflowId?: string; runId?: string },
  workflowId: string,
  runId: string,
): boolean {
  return record.runId === runId || record.workflowId === workflowId;
}

function sortRecordsByTimestamp(left: { createdAt: number }, right: { createdAt: number }): number {
  return left.createdAt - right.createdAt;
}

async function collectRunResultSnapshot(args: {
  frame: ExecutionFrame;
  memory: WorkflowContext["memory"];
  artifacts: RunArtifact[];
  lifecycle: LifecycleReport;
  history: ExecutionHistoryTracker;
}): Promise<CycleRunResult> {
  const runScopedFilter = {
    workflowId: args.frame.workflowId,
    runId: args.frame.runId
  } as const;
  const activeRecords = (await args.memory.list({ ...runScopedFilter, archived: false }))
    .filter((record) => isRunScopedRecord(record, args.frame.workflowId, args.frame.runId))
    .sort(sortRecordsByTimestamp);
  const archivedRecords = (await args.memory.list({ ...runScopedFilter, archived: true }))
    .filter((record) => isRunScopedRecord(record, args.frame.workflowId, args.frame.runId))
    .sort(sortRecordsByTimestamp);
  const stats = await args.memory.getStats(runScopedFilter);

  return {
    frame: args.frame,
    memory: {
      records: [...activeRecords, ...archivedRecords],
      activeRecords,
      archivedRecords,
      lifecycle: args.lifecycle,
      stats
    },
    artifacts: {
      artifacts: args.artifacts.map((artifact) => ({
        ...artifact,
        bytes: new Uint8Array(artifact.bytes)
      }))
    },
    history: args.history.snapshot(),
    flushMemory: async () =>
      args.memory.flush({
        workflowId: args.frame.workflowId,
        runId: args.frame.runId
      })
  };
}

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

  async run(
    key: string,
    input: WorkflowInput,
    options: RunOptions = {},
  ): Promise<CycleRunResult> {
    const controlKey = randomUUID();
    const control = new WorkflowRunControl();
    this.activeRuns.set(controlKey, control);
    const unregisterGlobalRun = registerGlobalWorkflowRun(control);

    const historyTracker = createExecutionHistoryTracker();
    const runBroadcaster = new ExecutionBroadcaster([
      ...this.broadcaster.listObservers(),
      ...(options.observers ?? []),
      historyTracker
    ]);

    await runBroadcaster.start();
    let finalStatus: "success" | "fail" | undefined;

    try {
      const result = await this.runInternal({
        key,
        input,
        options,
        broadcaster: runBroadcaster,
        historyTracker,
        control
      });
      finalStatus = result.frame.status === "success" ? "success" : "fail";
      return result;
    } finally {
      control.complete();
      unregisterGlobalRun();
      this.activeRuns.delete(controlKey);
      await runBroadcaster.stop(finalStatus);
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
    const branchId = options.branchId ?? `branch_${randomUUID().slice(0, 8)}`;
    const historyTracker = createExecutionHistoryTracker();
    broadcaster.addObserver(historyTracker);

    await broadcaster.emit({
      type: "branch.started",
      timestamp: this.now(),
      workflowId: parent.workflowId,
      runId: parent.runId,
      branchId,
      summary: options.summary ?? `sub-workflow ${key} started`,
      meta: {
        subWorkflowKey: key
      }
    });

    const workflow = this.workflows.get(key);
    if (!workflow) {
      broadcaster.removeObserver(historyTracker);
      throw new Error(`Workflow "${key}" is not registered.`);
    }

    try {
      const result = await this.runInternal({
        key,
        input,
        options,
        broadcaster,
        historyTracker,
        control,
        parent: {
          ...parent,
          branchId
        }
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
          childRunId: result.frame.runId
        }
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
          errorMessage: message
        }
      });
      throw error;
    } finally {
      broadcaster.removeObserver(historyTracker);
    }
  }

  private async runInternal(args: InternalRunOptions): Promise<CycleRunResult> {
    const workflow = this.workflows.get(args.key);
    if (!workflow) {
      throw new Error(`Workflow "${args.key}" is not registered.`);
    }
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
      now: this.now
    });
    const artifacts = createObservedArtifactStore({
      store: this.artifactStore,
      broadcaster: runBroadcaster,
      workflowId,
      runId,
      now: this.now,
      onCreate: (artifact) => {
        runArtifacts.push(artifact);
      }
    });
    let lifecycleReport = EMPTY_LIFECYCLE_REPORT;
    const abortAwareAIProvider = createAbortAwareAIProvider(this.aiProvider, args.control.signal);

    const meta =
      args.parent
        ? {
            parentWorkflowId: args.parent.workflowId,
            parentRunId: args.parent.runId,
            ...(args.parent.branchId ? { branchId: args.parent.branchId } : {})
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
      ...(meta ? { meta } : {})
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
          ...(meta ? { meta } : {})
        });

        await runBroadcaster.emit({
          type: "task.started",
          timestamp: this.now(),
          workflowId,
          runId,
          taskName: task.name,
          summary: `started ${task.name}`,
          ...(meta ? { meta } : {})
        });

        const log = createTaskLogger({
          broadcaster: runBroadcaster,
          workflowId,
          runId,
          taskName: task.name,
          ...(args.parent?.branchId ? { branchId: args.parent.branchId } : {}),
          now: this.now
        });
        const memoryContext = await memory.beforeStep({
          workflowId,
          runId,
          currentStep: frame.currentState,
          taskName: task.name,
          taskType: task.memoryTaskType,
          phase: task.memoryPhase,
          input: args.input,
          now: this.now()
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
                runId
              },
              key,
              input,
              runBroadcaster,
              args.control,
              options
            )
        };
        context.ai = createObservedAIProvider(abortAwareAIProvider, log);

        let result: TaskResult;
        try {
          args.control.throwIfRequested();
          if (task.before) {
            await task.before(context);
          }
          args.control.throwIfRequested();
          result = await task.run(context);
        } catch (error) {
          result = toFailureResult(error, args.control);
        }

        try {
          if (task.after) {
            await task.after(context, result);
          }
        } catch (error) {
          result = toFailureResult(error, args.control);
        }

        await memory.afterStep({
          workflowId,
          runId,
          currentStep: frame.currentState,
          taskName: task.name,
          taskType: task.memoryTaskType,
          phase: task.memoryPhase,
          input: args.input,
          result,
          now: this.now()
        });

        frame.taskResults[task.name] = result;
        frame.updatedAt = this.now();
        frame.checkpointSeq += 1;

        if (result.status === "fail") {
          const errorMessage = result.error?.message ?? `${task.name} failed`;
          lastErrorDetails = result.error?.details;
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
              status: result.status,
              ...(meta ? { meta } : {})
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
              ...(meta ? { meta } : {})
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
            ...(lastErrorDetails !== undefined ? { errorDetails: lastErrorDetails } : {})
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
            ...meta,
            completedTasks: [...frame.completedTasks]
          }
        });
      }

      await runBroadcaster.flush();
      return collectRunResultSnapshot({
        frame,
        memory,
        artifacts: runArtifacts,
        lifecycle: lifecycleReport,
        history: args.historyTracker
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
          ...(normalizedError instanceof Error
            ? { errorDetails: toSerializableErrorDetails(normalizedError) }
            : {})
        }
      });
      await runBroadcaster.flush();
      return collectRunResultSnapshot({
        frame,
        memory,
        artifacts: runArtifacts,
        lifecycle: lifecycleReport,
        history: args.historyTracker
      });
    }
  }
}

export function createCycle(options?: CycleOptions): Cycle {
  return new DefaultCycle(options);
}
