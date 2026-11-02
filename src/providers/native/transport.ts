import { setTimeout as delay } from "node:timers/promises";
import { combineAbortSignals } from "../../shared/abort.js";
import type { AIChatRequest, AIProviderOptions } from "../../types.js";
import {
  createDebugLoggingFetch,
  resolveHTTPDebugLogging,
} from "../openai/http.js";
import { nativeError, type NativeAPIType } from "./protocols.js";

export function nativeSettings(
  apiType: NativeAPIType,
  options: AIProviderOptions,
) {
  const prefix =
    apiType === "anthropic-messages"
      ? "ANTHROPIC"
      : apiType === "gemini-generate-content"
        ? "GEMINI"
        : "OPENAI";
  return {
    apiKey:
      options.apiKey ??
      process.env[`${prefix}_API_KEY`] ??
      (prefix === "GEMINI" ? process.env.GOOGLE_API_KEY : undefined),
    baseURL:
      options.baseURL ??
      process.env[`${prefix}_BASE_URL`] ??
      {
        "openai-responses": "https://api.openai.com/v1",
        "anthropic-messages": "https://api.anthropic.com/v1",
        "gemini-generate-content":
          "https://generativelanguage.googleapis.com/v1beta",
      }[apiType],
    defaultModel: options.defaultModel ?? process.env[`${prefix}_MODEL`],
  };
}

export function nativeURL(
  apiType: NativeAPIType,
  baseURL: string,
  model: string,
  streaming: boolean,
): URL {
  const url = new URL(baseURL);
  const suffix =
    apiType === "openai-responses"
      ? "responses"
      : apiType === "anthropic-messages"
        ? "messages"
        : `models/${encodeURIComponent(model.replace(/^models\//u, ""))}:${streaming ? "streamGenerateContent" : "generateContent"}`;
  url.pathname = `${url.pathname.replace(/\/+$/u, "")}/${suffix}`;
  if (apiType === "gemini-generate-content" && streaming)
    url.searchParams.set("alt", "sse");
  return url;
}

export async function sendNativeRequest(
  apiType: NativeAPIType,
  provider: string,
  model: string,
  request: AIChatRequest,
  options: AIProviderOptions,
  body: Record<string, unknown>,
  streaming: boolean,
) {
  const settings = nativeSettings(apiType, options);
  const url = nativeURL(
    apiType,
    request.http?.baseURL ?? settings.baseURL,
    model,
    streaming,
  );
  const headers = new Headers({
    "content-type": "application/json",
    accept: streaming ? "text/event-stream" : "application/json",
  });
  if (settings.apiKey) {
    headers.set(
      apiType === "anthropic-messages"
        ? "x-api-key"
        : apiType === "gemini-generate-content"
          ? "x-goog-api-key"
          : "authorization",
      apiType === "openai-responses"
        ? `Bearer ${settings.apiKey}`
        : settings.apiKey,
    );
  }
  if (apiType === "anthropic-messages")
    headers.set("anthropic-version", "2023-06-01");
  if (apiType === "openai-responses") {
    if (options.organization)
      headers.set("openai-organization", options.organization);
    if (options.project) headers.set("openai-project", options.project);
  }
  for (const source of [options.defaultHeaders, request.http?.headers]) {
    for (const [name, value] of Object.entries(source ?? {}))
      headers.set(name, value);
  }
  const maxRetries = request.http?.maxRetries ?? options.maxRetries ?? 2;
  const timeoutMs = request.http?.timeoutMs ?? options.timeoutMs ?? 60_000;
  if (!Number.isInteger(maxRetries) || maxRetries < 0)
    throw new Error("maxRetries must be a non-negative integer.");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0)
    throw new Error("timeoutMs must be a non-negative number.");
  const debug = resolveHTTPDebugLogging(options.httpDebugLogging);
  const fetchRequest = debug
    ? createDebugLoggingFetch(
        provider,
        debug,
        globalThis.fetch.bind(globalThis),
      )
    : globalThis.fetch.bind(globalThis);
  const serialized = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    request.http?.signal?.throwIfAborted();
    const signal = combineAbortSignals([
      request.http?.signal,
      timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
    ]);
    let retryable = true;
    let retryDelay = Math.min(250 * 2 ** attempt, 5_000);
    try {
      const response = await fetchRequest(url, {
        method: "POST",
        headers,
        body: serialized,
        ...(signal ? { signal } : {}),
      });
      if (response.ok) return { response, signal };
      retryable =
        [408, 409, 429].includes(response.status) || response.status >= 500;
      const retryAfter = response.headers.get("retry-after");
      if (retryAfter !== null) {
        const seconds = Number(retryAfter);
        const milliseconds = Number.isFinite(seconds)
          ? seconds * 1000
          : Date.parse(retryAfter) - Date.now();
        if (Number.isFinite(milliseconds))
          retryDelay = Math.min(Math.max(milliseconds, 0), 60_000);
      }
      const rawText = await response.text();
      let raw: unknown = rawText;
      try {
        raw = JSON.parse(rawText);
      } catch {
        /* Keep non-JSON server errors. */
      }
      throw nativeError(provider, model, raw, response);
    } catch (error) {
      request.http?.signal?.throwIfAborted();
      if (!retryable || attempt >= maxRetries) throw error;
      await delay(
        retryDelay,
        undefined,
        request.http?.signal ? { signal: request.http.signal } : {},
      );
    }
  }
}

/** SSE framing is independent of network chunk boundaries and UTF-8 splits. */
export async function* readServerEvents(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<{ event: string; data: unknown }> {
  if (!response.body) throw new Error("AI streaming response has no body.");
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("text/event-stream")
  )
    throw new Error("AI streaming response must use text/event-stream.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let data: string[] = [];
  function frame(line: string) {
    if (!line) {
      const result = data.length ? { event, data: data.join("\n") } : undefined;
      event = "";
      data = [];
      return result;
    }
    if (line.startsWith(":")) return undefined;
    const separator = line.indexOf(":");
    const name = separator < 0 ? line : line.slice(0, separator);
    const value =
      separator < 0 ? "" : line.slice(separator + 1).replace(/^ /u, "");
    if (name === "data") data.push(value);
    else if (name === "event") event = value;
    return undefined;
  }
  try {
    for (;;) {
      signal?.throwIfAborted();
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      if (chunk.done) buffer += "\n\n";
      let newline: RegExpExecArray | null;
      while ((newline = /\r\n|\r|\n/u.exec(buffer))) {
        if (
          !chunk.done &&
          newline[0] === "\r" &&
          newline.index === buffer.length - 1
        )
          break;
        const line = buffer.slice(0, newline.index);
        buffer = buffer.slice(newline.index + newline[0].length);
        const result = frame(line);
        if (result && result.data !== "[DONE]")
          yield {
            event: result.event,
            data: JSON.parse(result.data) as unknown,
          };
      }
      if (chunk.done) break;
    }
    signal?.throwIfAborted();
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
