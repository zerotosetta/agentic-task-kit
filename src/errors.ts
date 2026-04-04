import type { AIProviderRequestErrorDetails } from "./types.js";

const DEFAULT_WORKFLOW_CANCELLATION_MESSAGE = "Workflow cancelled by Ctrl+C.";

function safeStringify(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function buildMessage(details: AIProviderRequestErrorDetails): string {
  const parts = [`${details.provider} provider request failed`];

  if (details.model) {
    parts.push(`model=${details.model}`);
  }

  if (details.status !== undefined) {
    parts.push(`status=${details.status}`);
  }

  if (details.code) {
    parts.push(`code=${details.code}`);
  }

  if (details.type) {
    parts.push(`type=${details.type}`);
  }

  if (details.requestId) {
    parts.push(`requestId=${details.requestId}`);
  }

  if (details.originalError instanceof Error && details.originalError.message.length > 0) {
    parts.push(`error=${details.originalError.message}`);
  }

  if (details.responseBody !== undefined) {
    parts.push(`response=${safeStringify(details.responseBody)}`);
  }

  return parts.join(" | ");
}

export class AIProviderRequestError extends Error {
  readonly provider: string;
  readonly model: string | undefined;
  readonly status: number | undefined;
  readonly requestId: string | null | undefined;
  readonly code: string | null | undefined;
  readonly type: string | undefined;
  readonly param: string | null | undefined;
  readonly responseBody: unknown;
  readonly originalError: unknown;

  constructor(details: AIProviderRequestErrorDetails) {
    super(buildMessage(details), {
      cause: details.originalError instanceof Error ? details.originalError : undefined
    });

    this.name = "AIProviderRequestError";
    this.provider = details.provider;
    this.model = details.model;
    this.status = details.status;
    this.requestId = details.requestId;
    this.code = details.code;
    this.type = details.type;
    this.param = details.param;
    this.responseBody = details.responseBody;
    this.originalError = details.originalError;
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      provider: this.provider,
      model: this.model,
      status: this.status,
      requestId: this.requestId,
      code: this.code,
      type: this.type,
      param: this.param,
      responseBody: this.responseBody,
      originalError:
        this.originalError instanceof Error
          ? {
              name: this.originalError.name,
              message: this.originalError.message,
              stack: this.originalError.stack
            }
          : this.originalError
    };
  }
}

export class WorkflowCancellationError extends Error {
  readonly code = "ABORTED";

  constructor(message = DEFAULT_WORKFLOW_CANCELLATION_MESSAGE, options?: { cause?: unknown }) {
    super(message, {
      cause: options?.cause instanceof Error ? options.cause : undefined
    });

    this.name = "WorkflowCancellationError";
  }
}

export function isWorkflowCancellationError(error: unknown): error is WorkflowCancellationError {
  return error instanceof WorkflowCancellationError;
}

export function toWorkflowCancellationError(reason?: unknown): WorkflowCancellationError {
  if (reason instanceof WorkflowCancellationError) {
    return reason;
  }

  if (reason instanceof Error) {
    return new WorkflowCancellationError(reason.message || DEFAULT_WORKFLOW_CANCELLATION_MESSAGE, {
      cause: reason
    });
  }

  if (typeof reason === "string" && reason.trim().length > 0) {
    return new WorkflowCancellationError(reason);
  }

  return new WorkflowCancellationError(DEFAULT_WORKFLOW_CANCELLATION_MESSAGE);
}
