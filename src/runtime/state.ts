import { randomUUID } from "node:crypto";
import type {
  AISession,
  AISessionMessage,
  ExecutionFrame,
  ParallelTransition,
  Transition,
} from "../types.js";

export function createSession(
  llmModelId: string,
  embeddingModelId: string,
  messages: AISessionMessage[] = [],
): AISession {
  return {
    sessionId: randomUUID(),
    llmModelId,
    embeddingModelId,
    messages: [...messages],
    fork: () => createSession(llmModelId, embeddingModelId, messages),
  };
}

export function createFrame(
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
    errors: [],
  };
}

export function resolveTransition(
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

export function ensureSequentialOnly(
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
