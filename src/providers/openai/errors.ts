import { AIProviderRequestError } from "../../errors.js";
import type { AIProviderRequestErrorDetails } from "../../types.js";
import { type ResolvedAIHTTPDebugLoggingOptions, writeHTTPDebugLog } from "./http.js";

function getOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getOptionalNullableString(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  return getOptionalString(value);
}

export function toProviderRequestError(
  provider: string,
  model: string | undefined,
  error: unknown,
): AIProviderRequestError {
  if (error instanceof AIProviderRequestError) {
    return error;
  }

  const candidate =
    error && typeof error === "object"
      ? (error as {
          status?: unknown;
          requestID?: unknown;
          code?: unknown;
          type?: unknown;
          param?: unknown;
          error?: unknown;
        })
      : undefined;
  const requestId =
    candidate && "requestID" in candidate
      ? getOptionalNullableString(candidate.requestID)
      : undefined;
  const code =
    candidate && "code" in candidate ? getOptionalNullableString(candidate.code) : undefined;
  const type = candidate && "type" in candidate ? getOptionalString(candidate.type) : undefined;
  const param =
    candidate && "param" in candidate ? getOptionalNullableString(candidate.param) : undefined;

  const details: AIProviderRequestErrorDetails = {
    provider,
    ...(model ? { model } : {}),
    ...(typeof candidate?.status === "number" ? { status: candidate.status } : {}),
    ...(requestId !== undefined ? { requestId } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(type !== undefined ? { type } : {}),
    ...(param !== undefined ? { param } : {}),
    ...(candidate && "error" in candidate
      ? {
          responseBody: candidate.error,
        }
      : {}),
    originalError: error,
  };

  return new AIProviderRequestError(details);
}

export function writeProviderErrorDebugLog(
  config: ResolvedAIHTTPDebugLoggingOptions | undefined,
  provider: string,
  model: string | undefined,
  error: AIProviderRequestError,
): void {
  if (!config) {
    return;
  }

  writeHTTPDebugLog(config, {
    phase: "error",
    provider,
    ...(model ? { model } : {}),
    ...(error.status !== undefined ? { status: error.status } : {}),
    ...(error.requestId ? { requestId: error.requestId } : {}),
    ...(error.code ? { code: error.code } : {}),
    ...(error.type ? { type: error.type } : {}),
    ...(error.param ? { param: error.param } : {}),
    ...(error.responseBody !== undefined ? { responseBody: error.responseBody } : {}),
    error: error.message,
    originalError:
      error.originalError instanceof Error
        ? {
            name: error.originalError.name,
            message: error.originalError.message,
          }
        : error.originalError,
  });
}
