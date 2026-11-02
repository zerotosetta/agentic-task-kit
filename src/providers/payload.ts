import type { AIChatRequest } from "../types.js";

export function mergePayload(
  request: AIChatRequest,
  defaults: Record<string, unknown> | undefined,
  mapped: Record<string, unknown>,
): Record<string, unknown> {
  for (const value of [defaults, request.payload]) {
    if (
      value !== undefined &&
      (!value || typeof value !== "object" || Array.isArray(value))
    ) {
      throw new TypeError("AI payload must be an object.");
    }
  }
  if (request.payloadMode === "replace") {
    if (!request.payload)
      throw new Error("payloadMode=replace requires payload.");
    return { ...request.payload };
  }
  return { ...defaults, ...mapped, ...request.payload };
}

export function resolveRequestModel(
  request: AIChatRequest,
  defaultModel?: string,
  defaultPayload?: Record<string, unknown>,
): string | undefined {
  const value =
    request.payload?.model ??
    request.model ??
    (request.payloadMode === "replace" ? undefined : defaultPayload?.model) ??
    defaultModel;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
