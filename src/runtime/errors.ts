import { extractSourceLocationFromStack } from "../error-location.js";
import { toWorkflowCancellationError } from "../errors.js";
import type { TaskResult, WorkflowCancellation } from "../types.js";

export function toSerializableErrorDetails(error: unknown, depth = 0): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  const details: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === "string") {
    details.code = code;
  }

  const sourceLocation = extractSourceLocationFromStack(error.stack);
  if (sourceLocation) {
    details.sourceLocation = sourceLocation;
  }

  const cause = "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  if (cause !== undefined && depth < 3) {
    details.cause = toSerializableErrorDetails(cause, depth + 1);
  }
  if (error instanceof AggregateError && depth < 3) {
    details.errors = error.errors.map((nested: unknown) =>
      toSerializableErrorDetails(nested, depth + 1),
    );
  }

  return details;
}

export function toFailureResult(error: unknown, control: WorkflowCancellation): TaskResult {
  if (control.isCancellationRequested()) {
    const cancellationError = toWorkflowCancellationError(control.reason);
    return {
      status: "fail",
      error: {
        message: cancellationError.message,
        code: cancellationError.code,
        details: toSerializableErrorDetails(error),
      },
    };
  }

  if (error instanceof Error) {
    return {
      status: "fail",
      error: {
        message: error.message,
        ...("code" in error && typeof (error as { code?: unknown }).code === "string"
          ? { code: (error as { code: string }).code }
          : {}),
        details: toSerializableErrorDetails(error),
      },
    };
  }

  return {
    status: "fail",
    error: {
      message: String(error),
    },
  };
}
