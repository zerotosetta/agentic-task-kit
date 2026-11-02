import type {
  AIChatRequest,
  WebChatAssistantResult,
  WebChatCompletionContext,
  WebChatProviderSettings,
  WebChatValuePath,
} from "../../types.js";
import { mergePayload } from "../payload.js";

export function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
export function valueAt(raw: unknown, path: WebChatValuePath): unknown {
  let value = raw;
  for (const key of path) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key))
      return undefined;
    value = (value as Record<string | number, unknown>)[key];
  }
  return value;
}
export function buildMessages(
  request: AIChatRequest,
  defaults?: Record<string, unknown>,
): Record<string, unknown>[] {
  const native = mergePayload(request, defaults, {});
  if (request.payloadMode === "replace") return [native];
  if (request.messages?.length) {
    return request.messages.map((message, index) => ({
      ...defaults,
      ...message,
      ...(index === request.messages!.length - 1 ? request.payload : {}),
    }));
  }
  if (request.payload || defaults) return [native];
  throw new Error(
    "WebChat chat requires messages or a native message payload.",
  );
}
function decode(entry: unknown): Record<string, unknown> {
  const item = record(entry);
  if (typeof item.contents === "string") {
    try {
      return record(JSON.parse(item.contents));
    } catch {
      /* Not a known message envelope. */
    }
  }
  return item;
}
function history(raw: unknown): unknown[] {
  return Array.isArray(raw)
    ? raw
    : Array.isArray(record(raw).message_history)
      ? (record(raw).message_history as unknown[])
      : [];
}
function sameMessage(
  candidate: unknown,
  message: Record<string, unknown>,
): boolean {
  const decoded = decode(candidate);
  return (
    typeof message.role === "string" &&
    Object.hasOwn(message, "content") &&
    decoded.role === message.role &&
    JSON.stringify(decoded.content) === JSON.stringify(message.content)
  );
}
export function submittedMessageId(
  raw: unknown,
  message: Record<string, unknown>,
): string | number | undefined {
  const entries = history(raw);
  const entry = entries[lastMatchingIndex(entries, message)];
  const id = record(entry).message_id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}
function lastMatchingIndex(
  entries: unknown[],
  message: Record<string, unknown>,
): number {
  for (let index = entries.length - 1; index >= 0; index--)
    if (sameMessage(entries[index], message)) return index;
  return -1;
}
function answer(
  message: Record<string, unknown>,
): WebChatAssistantResult | undefined {
  if (message.role !== "assistant") return undefined;
  const content = message.content;
  if (typeof content === "string") return { text: content };
  if (Array.isArray(content))
    return {
      text: content
        .map((part) =>
          typeof record(part).text === "string" ? record(part).text : "",
        )
        .join(""),
    };
  if (message.tool_calls || content === null) return { text: "" };
  return undefined;
}
export function extractAssistant(
  raw: unknown,
  context: WebChatCompletionContext,
  settings: WebChatProviderSettings,
): WebChatAssistantResult | undefined {
  if (
    settings.readyWhen &&
    valueAt(raw, settings.readyWhen.path) !== settings.readyWhen.equals
  )
    return undefined;
  if (settings.extractAssistant) return settings.extractAssistant(raw, context);
  const selected = settings.responsePath
    ? valueAt(raw, settings.responsePath)
    : raw;
  if (settings.responsePath && typeof selected === "string")
    return { text: selected };
  const direct = decode(selected);
  if (!sameMessage(direct, context.lastMessage)) {
    const result = answer(direct);
    if (result) return result;
  }
  const entries = history(selected);
  let start =
    context.messageId !== undefined
      ? entries.findIndex(
          (item) =>
            record(item).message_id === context.messageId &&
            sameMessage(item, context.lastMessage),
        )
      : -1;
  if (start < 0) start = lastMatchingIndex(entries, context.lastMessage);
  if (start < 0) return undefined;
  let result: WebChatAssistantResult | undefined;
  for (const entry of entries.slice(start + 1)) {
    const message = decode(entry);
    // Never attribute an answer following another user's question to this call.
    if (message.role === "user") break;
    result = answer(message) ?? result;
  }
  return result;
}
