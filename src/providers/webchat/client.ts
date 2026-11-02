import { setTimeout as delay } from "node:timers/promises";
import { AIProviderRequestError } from "../../errors.js";
import { combineAbortSignals } from "../../shared/abort.js";
import type {
  AIChatRequest,
  WebChatAIProviderOptions,
  WebChatEndpoint,
} from "../../types.js";
import {
  createDebugLoggingFetch,
  resolveHTTPDebugLogging,
} from "../openai/http.js";
import { record } from "./messages.js";

export type Bindings = {
  sessionId?: string;
  messageId?: string | number;
  model?: string;
  assistantUUID?: string;
};
export type Operation = {
  model: string;
  signal: AbortSignal;
  send(
    endpoint: WebChatEndpoint,
    bindings?: Bindings,
    creating?: boolean,
  ): Promise<unknown>;
};

export function validateEndpoint(endpoint: WebChatEndpoint): void {
  if (typeof endpoint.path !== "string" || !endpoint.path.trim())
    throw new Error("WebChat endpoint requires a non-empty path.");
  if (
    endpoint.method !== undefined &&
    endpoint.method !== "GET" &&
    endpoint.method !== "POST"
  )
    throw new Error("WebChat endpoint method must be GET or POST.");
  if ((endpoint.method ?? "GET") === "GET" && endpoint.payload !== undefined)
    throw new Error(
      "WebChat GET endpoint cannot have a payload; use a query string or POST.",
    );
}

export async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
function interpolate(
  value: unknown,
  bindings: Bindings,
  path = false,
): unknown {
  if (typeof value === "string") {
    const full = /^\{(sessionId|messageId|model|assistantUUID)\}$/u.exec(value);
    const substitute = (name: string) => {
      const result = bindings[name as keyof Bindings];
      if (result === undefined)
        throw new Error(`WebChat endpoint requires {${name}}.`);
      return result;
    };
    if (full && !path) return substitute(full[1]!);
    return value.replace(
      /\{(sessionId|messageId|model|assistantUUID)\}/gu,
      (_match, name: string) =>
        path
          ? encodeURIComponent(String(substitute(name)))
          : String(substitute(name)),
    );
  }
  if (Array.isArray(value))
    return value.map((item) => interpolate(item, bindings));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        interpolate(item, bindings),
      ]),
    );
  return value;
}

export class WebChatClient {
  readonly baseURL: string;
  constructor(
    private readonly options: WebChatAIProviderOptions,
    private readonly provider: string,
  ) {
    const baseURL = options.baseURL ?? process.env.WEBCHAT_BASE_URL;
    if (!baseURL)
      throw new Error("WebChat requires baseURL or WEBCHAT_BASE_URL.");
    const parsed = new URL(baseURL);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      throw new Error("WebChat baseURL must use HTTP or HTTPS.");
    if (!parsed.pathname.endsWith("/")) parsed.pathname += "/";
    this.baseURL = parsed.href;
  }
  operation(request: AIChatRequest, model: string): Operation {
    const timeoutMs =
      request.http?.timeoutMs ?? this.options.timeoutMs ?? 60_000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0)
      throw new Error("WebChat timeoutMs must be a non-negative integer.");
    const signal =
      combineAbortSignals([
        request.http?.signal,
        timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
      ]) ?? new AbortController().signal;
    const operation: Operation = {
      model,
      signal,
      send: (endpoint, bindings = {}, creating = false) =>
        this.send(request, operation, endpoint, bindings, creating),
    };
    return operation;
  }
  private async send(
    request: AIChatRequest,
    operation: Operation,
    endpoint: WebChatEndpoint,
    bindings: Bindings,
    creating: boolean,
  ): Promise<unknown> {
    operation.signal.throwIfAborted();
    validateEndpoint(endpoint);
    const method = endpoint.method ?? "GET";
    if (method !== "GET" && method !== "POST")
      throw new Error("WebChat endpoint method must be GET or POST.");
    const path = interpolate(endpoint.path, bindings, true) as string;
    const baseURL = request.http?.baseURL ?? this.baseURL;
    const url = new URL(path, baseURL.endsWith("/") ? baseURL : baseURL + "/");
    const settings = this.options.webChat ?? {};
    const keyHeader = settings.apiKeyHeader ?? "BXCode-User-API-Key";
    const key = this.options.apiKey ?? process.env.WEBCHAT_API_KEY;
    const headers = new Headers({
      accept: "application/json",
      "content-type": "application/json",
    });
    if (key) headers.set(keyHeader, key);
    if (creating)
      headers.set("Max-Session-Count", String(settings.maxSessionCount ?? 100));
    for (const source of [this.options.defaultHeaders, request.http?.headers])
      for (const [key, value] of Object.entries(source ?? {}))
        headers.set(key, value);
    const debug = resolveHTTPDebugLogging(this.options.httpDebugLogging);
    const fetchRequest = debug
      ? createDebugLoggingFetch(
          this.provider,
          {
            ...debug,
            redactHeaders: [
              ...new Set([
                ...debug.redactHeaders,
                "authorization",
                "proxy-authorization",
                "cookie",
                "set-cookie",
                "api-key",
                "x-api-key",
                "x-goog-api-key",
                keyHeader.toLowerCase(),
                "bxcode-user-api-key",
              ]),
            ],
          },
          globalThis.fetch.bind(globalThis),
        )
      : globalThis.fetch.bind(globalThis);
    const maxRetries = request.http?.maxRetries ?? this.options.maxRetries ?? 2;
    if (!Number.isInteger(maxRetries) || maxRetries < 0)
      throw new Error("WebChat maxRetries must be a non-negative integer.");
    if (method === "GET" && endpoint.payload !== undefined)
      throw new Error(
        "WebChat GET endpoint cannot have a payload; use a query string or POST.",
      );
    const body =
      endpoint.payload === undefined
        ? undefined
        : JSON.stringify(
            endpoint.templatePayload
              ? interpolate(endpoint.payload, bindings)
              : endpoint.payload,
          );
    for (let attempt = 0; ; attempt++) {
      let retry = method === "GET" && attempt < maxRetries;
      try {
        const response = await fetchRequest(url, {
          method,
          headers,
          ...(body !== undefined ? { body } : {}),
          signal: operation.signal,
          redirect: "error",
        });
        if (
          response.ok &&
          response.headers
            .get("content-type")
            ?.toLowerCase()
            .includes("text/event-stream")
        ) {
          retry = false;
          await response.body?.cancel();
          throw new Error(
            "WebChat JSON completion received SSE. Supply a custom completion callback for the actual streaming protocol.",
          );
        }
        const text = await response.text();
        let raw: unknown = text;
        let validJSON = !text;
        try {
          raw = text ? JSON.parse(text) : null;
          validJSON = true;
        } catch {
          /* Preserve a non-JSON error body. */
        }
        if (response.ok) {
          retry = false;
          if (!validJSON) throw new Error("WebChat expected a JSON response.");
          operation.signal.throwIfAborted();
          return raw;
        }
        retry &&=
          [408, 409, 429].includes(response.status) || response.status >= 500;
        const error = record(record(raw).error ?? raw);
        throw new AIProviderRequestError({
          provider: this.provider,
          model: operation.model,
          status: response.status,
          requestId: response.headers.get("x-request-id"),
          ...(typeof error.code === "string" ? { code: error.code } : {}),
          responseBody: raw,
          originalError: new Error(
            typeof error.message === "string"
              ? error.message
              : `WebChat HTTP ${response.status}`,
          ),
        });
      } catch (error) {
        operation.signal.throwIfAborted();
        if (!retry) throw error;
        await delay(Math.min(250 * 2 ** attempt, 5_000), undefined, {
          signal: operation.signal,
        });
      }
    }
  }
}
