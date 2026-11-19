import type { DurableErrorCause } from "./types/durable.js";

export interface NormalizedFailure extends DurableErrorCause {
  cause?: DurableErrorCause;
}

const incompatibleCheckpoint = new Set([
  "ARTIFACT_MISMATCH",
  "CHECKPOINT_SCHEMA_MISMATCH",
  "INPUT_SNAPSHOT_MISMATCH",
  "WORKFLOW_REVISION_MISMATCH",
]);

export function isNonRecoverableFailure(error: NormalizedFailure | null): boolean {
  if (!error) return false;
  return error.recoverable === false || incompatibleCheckpoint.has(error.code) ||
    (error.cause !== undefined && (error.cause.recoverable === false || incompatibleCheckpoint.has(error.cause.code)));
}

function errorFields(value: unknown) {
  const fields = typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
  return {
    code: typeof fields?.code === "string" && fields.code.trim() ? fields.code : undefined,
    message: typeof fields?.message === "string" ? fields.message : undefined,
    recoverable: typeof fields?.recoverable === "boolean" ? fields.recoverable : undefined,
    cause: fields?.cause,
  };
}

/** Keep only caller-facing diagnostics from Error instances or structured thrown values. */
export function normalizeFailure(error: unknown, fallbackCode: string, fallbackMessage = fallbackCode): NormalizedFailure {
  const fields = errorFields(error);
  const failure: NormalizedFailure = {
    code: fields.code ?? fallbackCode,
    message: fields.message ?? (typeof error === "string" && error.trim() ? error : fallbackMessage),
  };
  if (fields.recoverable !== undefined) failure.recoverable = fields.recoverable;

  // A durable wrapper (or an uncoded Error) can carry the plugin's original error in cause.
  if (!fields.code || fields.code === "STEP_FAILED") {
    const seen = new Set<unknown>([error]);
    let nested = fields.cause;
    while (typeof nested === "object" && nested !== null && !seen.has(nested)) {
      seen.add(nested);
      const inner = errorFields(nested);
      if (inner.code && inner.code !== "STEP_FAILED" && inner.message !== undefined) {
        failure.cause = { code: inner.code, message: inner.message };
        if (inner.recoverable !== undefined) {
          failure.cause.recoverable = inner.recoverable;
          failure.recoverable ??= inner.recoverable;
        }
        break;
      }
      nested = inner.cause;
    }
  }
  if (isNonRecoverableFailure(failure)) failure.recoverable = false;
  return failure;
}
