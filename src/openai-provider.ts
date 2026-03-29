import OpenAI, { type ClientOptions } from "openai";

import type {
  AIChatRequest,
  AIChatResponse,
  AIChatStream,
  AIChatStreamChunk,
  AIChatUsage,
  AIHTTPHeaders,
  AIProvider,
  AISessionMessage,
  OpenAICompatibleChatProviderOptions,
  OpenAIChatProviderOptions
} from "./types.js";

type ResolvedOpenAICompatibleChatProviderOptions = {
  providerName: string;
  apiKey: string | undefined;
  baseURL: string | undefined;
  organization: string | undefined;
  project: string | undefined;
  defaultHeaders: AIHTTPHeaders | undefined;
  httpDebugLogging: ResolvedAIHTTPDebugLoggingOptions | undefined;
  defaultModel: string | undefined;
  timeoutMs: number | undefined;
  maxRetries: number | undefined;
  defaultTemperature: number | undefined;
  defaultMaxCompletionTokens: number | undefined;
  defaultReasoningEffort:
    | OpenAICompatibleChatProviderOptions["defaultReasoningEffort"]
    | undefined;
};

type ResolvedAIHTTPDebugLoggingOptions = {
  stream: NodeJS.WritableStream;
  includeHeaders: boolean;
  includeResponseHeaders: boolean;
  includeRequestBody: boolean;
  redactHeaders: string[];
};

class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly resolvers: Array<{
    resolve: (value: IteratorResult<T>) => void;
    reject: (reason?: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver.resolve({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    this.failure = error;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          return Promise.resolve({
            value: this.values.shift() as T,
            done: false
          });
        }

        if (this.failure !== undefined) {
          return Promise.reject(this.failure);
        }

        if (this.closed) {
          return Promise.resolve({
            value: undefined,
            done: true
          });
        }

        return new Promise<IteratorResult<T>>((resolve, reject) => {
          this.resolvers.push({ resolve, reject });
        });
      }
    };
  }
}

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }

  return undefined;
}

function parseOptionalHeaders(value: string | undefined): AIHTTPHeaders | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("OPENAI_DEFAULT_HEADERS_JSON must be a JSON object.");
  }

  const entries = Object.entries(parsed);
  const headers: AIHTTPHeaders = {};

  for (const [key, headerValue] of entries) {
    if (typeof headerValue !== "string") {
      throw new Error("OPENAI_DEFAULT_HEADERS_JSON values must be strings.");
    }

    headers[key] = headerValue;
  }

  return headers;
}

function cloneHeaders(headers: AIHTTPHeaders | undefined): AIHTTPHeaders | undefined {
  if (!headers) {
    return undefined;
  }

  return { ...headers };
}

function resolveHTTPDebugLogging(
  option: OpenAICompatibleChatProviderOptions["httpDebugLogging"]
): ResolvedAIHTTPDebugLoggingOptions | undefined {
  const explicitEnabled =
    option === undefined
      ? undefined
      : typeof option === "boolean"
        ? option
        : option.enabled ?? true;
  const envEnabled = parseOptionalBoolean(process.env.OPENAI_HTTP_DEBUG);
  const enabled = explicitEnabled ?? envEnabled ?? false;

  if (!enabled) {
    return undefined;
  }

  const details =
    option && typeof option === "object" && !Array.isArray(option) ? option : undefined;

  return {
    stream: details?.stream ?? process.stderr,
    includeHeaders:
      details?.includeHeaders ??
      parseOptionalBoolean(process.env.OPENAI_HTTP_DEBUG_HEADERS) ??
      true,
    includeResponseHeaders:
      details?.includeResponseHeaders ??
      parseOptionalBoolean(process.env.OPENAI_HTTP_DEBUG_RESPONSE_HEADERS) ??
      true,
    includeRequestBody:
      details?.includeRequestBody ??
      parseOptionalBoolean(process.env.OPENAI_HTTP_DEBUG_BODY) ??
      false,
    redactHeaders: details?.redactHeaders ?? ["authorization", "api-key", "x-api-key"]
  };
}

function toHeaderObject(
  headers: Headers,
  redactHeaders: string[]
): Record<string, string> {
  const redactions = new Set(redactHeaders.map((header) => header.toLowerCase()));
  const entries: Record<string, string> = {};

  headers.forEach((value, key) => {
    entries[key] = redactions.has(key.toLowerCase()) ? "[REDACTED]" : value;
  });

  return entries;
}

function estimateBodyBytes(body: unknown): number | undefined {
  if (typeof body === "string") {
    return Buffer.byteLength(body);
  }

  if (body instanceof Uint8Array) {
    return body.byteLength;
  }

  if (body instanceof ArrayBuffer) {
    return body.byteLength;
  }

  return undefined;
}

function serializeRequestBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return "[non-text body omitted]";
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function resolveRequestMethod(input: RequestInfo | URL, init?: RequestInit): string {
  if (init?.method) {
    return init.method;
  }

  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.method;
  }

  return "GET";
}

function resolveRequestURL(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  if (typeof Request !== "undefined" && input instanceof Request) {
    return input.url;
  }

  return String(input);
}

function writeHTTPDebugLog(
  config: ResolvedAIHTTPDebugLoggingOptions,
  payload: Record<string, unknown>
): void {
  config.stream.write(`[cycle:http] ${JSON.stringify(payload)}\n`);
}

function createDebugLoggingFetch(
  providerName: string,
  config: ResolvedAIHTTPDebugLoggingOptions,
  baseFetch: typeof fetch
): typeof fetch {
  return async (input, init) => {
    const method = resolveRequestMethod(input, init);
    const url = resolveRequestURL(input);
    const startedAt = Date.now();
    const requestHeaders = new Headers(
      init?.headers ??
        (typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined)
    );
    const requestBody = init?.body;

    writeHTTPDebugLog(config, {
      phase: "request",
      provider: providerName,
      method,
      url,
      bodyBytes: estimateBodyBytes(requestBody),
      ...(config.includeHeaders
        ? {
            headers: toHeaderObject(requestHeaders, config.redactHeaders)
          }
        : {}),
      ...(config.includeRequestBody
        ? {
            body: serializeRequestBody(requestBody)
          }
        : {})
    });

    try {
      const response = await baseFetch(input, init);
      writeHTTPDebugLog(config, {
        phase: "response",
        provider: providerName,
        method,
        url,
        status: response.status,
        statusText: response.statusText,
        durationMs: Date.now() - startedAt,
        requestId: response.headers.get("x-request-id"),
        contentType: response.headers.get("content-type"),
        ...(config.includeResponseHeaders
          ? {
              headers: toHeaderObject(response.headers, config.redactHeaders)
            }
          : {})
      });
      return response;
    } catch (error) {
      writeHTTPDebugLog(config, {
        phase: "error",
        provider: providerName,
        method,
        url,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  };
}

function resolveOptions(
  options: OpenAICompatibleChatProviderOptions = {}
): ResolvedOpenAICompatibleChatProviderOptions {
  return {
    providerName:
      options.providerName ?? process.env.OPENAI_PROVIDER_NAME ?? "openai-chat-completions",
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    baseURL: options.baseURL ?? process.env.OPENAI_BASE_URL,
    organization: options.organization ?? process.env.OPENAI_ORG_ID,
    project: options.project ?? process.env.OPENAI_PROJECT_ID,
    defaultHeaders:
      cloneHeaders(options.defaultHeaders) ?? parseOptionalHeaders(process.env.OPENAI_DEFAULT_HEADERS_JSON),
    httpDebugLogging: resolveHTTPDebugLogging(options.httpDebugLogging),
    defaultModel: options.defaultModel ?? process.env.OPENAI_MODEL,
    timeoutMs: options.timeoutMs ?? parseOptionalInteger(process.env.OPENAI_TIMEOUT_MS),
    maxRetries: options.maxRetries ?? parseOptionalInteger(process.env.OPENAI_MAX_RETRIES),
    defaultTemperature: options.defaultTemperature,
    defaultMaxCompletionTokens:
      options.defaultMaxCompletionTokens ??
      parseOptionalInteger(process.env.OPENAI_MAX_COMPLETION_TOKENS),
    defaultReasoningEffort:
      options.defaultReasoningEffort ??
      (process.env.OPENAI_REASONING_EFFORT as OpenAICompatibleChatProviderOptions["defaultReasoningEffort"])
  };
}

function createClientOptions(
  options: ResolvedOpenAICompatibleChatProviderOptions
): ClientOptions {
  const clientOptions: ClientOptions = {};

  if (options.apiKey !== undefined) {
    clientOptions.apiKey = options.apiKey;
  }

  if (options.baseURL !== undefined) {
    clientOptions.baseURL = options.baseURL;
  }

  if (options.organization !== undefined) {
    clientOptions.organization = options.organization;
  }

  if (options.project !== undefined) {
    clientOptions.project = options.project;
  }

  if (options.timeoutMs !== undefined) {
    clientOptions.timeout = options.timeoutMs;
  }

  if (options.maxRetries !== undefined) {
    clientOptions.maxRetries = options.maxRetries;
  }

  if (options.defaultHeaders !== undefined) {
    clientOptions.defaultHeaders = options.defaultHeaders;
  }

  if (options.httpDebugLogging !== undefined) {
    clientOptions.fetch = createDebugLoggingFetch(
      options.providerName,
      options.httpDebugLogging,
      globalThis.fetch.bind(globalThis)
    );
  }

  return clientOptions;
}

function toOpenAIMessage(message: AISessionMessage): OpenAI.ChatCompletionMessageParam {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content
    };
  }

  if (message.role === "developer") {
    return message.name
      ? {
          role: "developer",
          content: message.content,
          name: message.name
        }
      : {
          role: "developer",
          content: message.content
        };
  }

  if (message.role === "system") {
    return message.name
      ? {
          role: "system",
          content: message.content,
          name: message.name
        }
      : {
          role: "system",
          content: message.content
        };
  }

  return message.name
    ? {
        role: "user",
        content: message.content,
        name: message.name
      }
    : {
        role: "user",
        content: message.content
      };
}

function extractText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }

      if (!part || typeof part !== "object") {
        return "";
      }

      if ("text" in part && typeof part.text === "string") {
        return part.text;
      }

      return "";
    })
    .join("");
}

function toUsage(usage: unknown): AIChatUsage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const promptTokens = "prompt_tokens" in usage && typeof usage.prompt_tokens === "number"
    ? usage.prompt_tokens
    : undefined;
  const completionTokens =
    "completion_tokens" in usage && typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : undefined;
  const totalTokens = "total_tokens" in usage && typeof usage.total_tokens === "number"
    ? usage.total_tokens
    : undefined;
  const reasoningTokens =
    "completion_tokens_details" in usage &&
    usage.completion_tokens_details &&
    typeof usage.completion_tokens_details === "object" &&
    "reasoning_tokens" in usage.completion_tokens_details &&
    typeof usage.completion_tokens_details.reasoning_tokens === "number"
      ? usage.completion_tokens_details.reasoning_tokens
      : undefined;

  if (
    promptTokens === undefined &&
    completionTokens === undefined &&
    totalTokens === undefined &&
    reasoningTokens === undefined
  ) {
    return undefined;
  }

  return {
    ...(promptTokens !== undefined ? { inputTokens: promptTokens } : {}),
    ...(completionTokens !== undefined ? { outputTokens: completionTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {})
  };
}

function buildRequestOptions(request: AIChatRequest) {
  const requestOptions: {
    headers?: AIHTTPHeaders;
    timeout?: number;
    maxRetries?: number;
    defaultBaseURL?: string;
  } = {};

  if (request.http?.headers !== undefined) {
    requestOptions.headers = request.http.headers;
  }

  if (request.http?.timeoutMs !== undefined) {
    requestOptions.timeout = request.http.timeoutMs;
  }

  if (request.http?.maxRetries !== undefined) {
    requestOptions.maxRetries = request.http.maxRetries;
  }

  if (request.http?.baseURL !== undefined) {
    requestOptions.defaultBaseURL = request.http.baseURL;
  }

  return requestOptions;
}

function buildNonStreamingBody(
  model: string,
  request: AIChatRequest,
  defaults: {
    defaultTemperature: number | undefined;
    defaultMaxCompletionTokens: number | undefined;
    defaultReasoningEffort:
      | OpenAICompatibleChatProviderOptions["defaultReasoningEffort"]
      | undefined;
  }
): OpenAI.ChatCompletionCreateParamsNonStreaming {
  const resolvedTemperature = request.temperature ?? defaults.defaultTemperature;
  const resolvedMaxCompletionTokens =
    request.maxCompletionTokens ?? defaults.defaultMaxCompletionTokens;
  const resolvedReasoningEffort = request.reasoningEffort ?? defaults.defaultReasoningEffort;

  const body: OpenAI.ChatCompletionCreateParamsNonStreaming = {
    model,
    messages: request.messages.map(toOpenAIMessage)
  };

  if (resolvedTemperature !== undefined) {
    body.temperature = resolvedTemperature;
  }

  if (resolvedMaxCompletionTokens !== undefined) {
    body.max_completion_tokens = resolvedMaxCompletionTokens;
  }

  if (resolvedReasoningEffort !== undefined) {
    body.reasoning_effort = resolvedReasoningEffort;
  }

  if (request.metadata !== undefined) {
    body.metadata = request.metadata;
  }

  if (request.promptCacheKey !== undefined) {
    body.prompt_cache_key = request.promptCacheKey;
  }

  return body;
}

function buildStreamingBody(
  model: string,
  request: AIChatRequest,
  defaults: {
    defaultTemperature: number | undefined;
    defaultMaxCompletionTokens: number | undefined;
    defaultReasoningEffort:
      | OpenAICompatibleChatProviderOptions["defaultReasoningEffort"]
      | undefined;
  }
): OpenAI.ChatCompletionCreateParamsStreaming {
  return {
    ...buildNonStreamingBody(model, request, defaults),
    stream: true
  };
}

class OpenAICompatibleChatProvider implements AIProvider {
  readonly provider: string;
  readonly defaultChatModel: string | undefined;

  private readonly client: OpenAI;
  private readonly defaultTemperature: number | undefined;
  private readonly defaultMaxCompletionTokens: number | undefined;
  private readonly defaultReasoningEffort:
    | OpenAICompatibleChatProviderOptions["defaultReasoningEffort"]
    | undefined;

  constructor(options: OpenAICompatibleChatProviderOptions = {}) {
    const resolved = resolveOptions(options);
    this.provider = resolved.providerName;
    this.client = new OpenAI(createClientOptions(resolved));
    this.defaultChatModel = resolved.defaultModel;
    this.defaultTemperature = resolved.defaultTemperature;
    this.defaultMaxCompletionTokens = resolved.defaultMaxCompletionTokens;
    this.defaultReasoningEffort = resolved.defaultReasoningEffort;
  }

  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const model = request.model ?? this.defaultChatModel;
    if (!model) {
      throw new Error(
        "No OpenAI-compatible chat model configured. Set `defaultModel` in `createOpenAICompatibleChatProvider()` or pass `model` to `ctx.ai.chat()`."
      );
    }

    const completion = await this.client.chat.completions.create(
      buildNonStreamingBody(model, request, {
        defaultTemperature: this.defaultTemperature,
        defaultMaxCompletionTokens: this.defaultMaxCompletionTokens,
        defaultReasoningEffort: this.defaultReasoningEffort
      }),
      buildRequestOptions(request)
    );

    const firstChoice = completion.choices[0];
    const outputText = extractText(firstChoice?.message.content).trim();
    const usage = toUsage(completion.usage);

    return {
      provider: this.provider,
      model: completion.model,
      outputText,
      message: {
        role: "assistant",
        content: outputText
      },
      finishReason: firstChoice?.finish_reason ?? null,
      ...(usage ? { usage } : {}),
      raw: completion
    };
  }

  async chatStream(request: AIChatRequest): Promise<AIChatStream> {
    const model = request.model ?? this.defaultChatModel;
    if (!model) {
      throw new Error(
        "No OpenAI-compatible chat model configured. Set `defaultModel` in `createOpenAICompatibleChatProvider()` or pass `model` to `ctx.ai.chatStream()`."
      );
    }

    const queue = new AsyncQueue<AIChatStreamChunk>();
    let outputText = "";
    let resolvedModel = model;
    let finishReason: string | null | undefined = null;
    let usage: AIChatUsage | undefined;
    const rawChunks: OpenAI.ChatCompletionChunk[] = [];

    const finalResponse = (async () => {
      try {
        const stream = await this.client.chat.completions.create(
          buildStreamingBody(model, request, {
            defaultTemperature: this.defaultTemperature,
            defaultMaxCompletionTokens: this.defaultMaxCompletionTokens,
            defaultReasoningEffort: this.defaultReasoningEffort
          }),
          buildRequestOptions(request)
        );

        for await (const chunk of stream) {
          rawChunks.push(chunk);
          resolvedModel = chunk.model || resolvedModel;

          const firstChoice = chunk.choices[0];
          const deltaText = extractText(firstChoice?.delta?.content);
          outputText += deltaText;

          if (firstChoice?.finish_reason !== undefined && firstChoice.finish_reason !== null) {
            finishReason = firstChoice.finish_reason;
          }

          const nextUsage = toUsage(chunk.usage);
          if (nextUsage) {
            usage = nextUsage;
          }

          queue.push({
            provider: this.provider,
            model: resolvedModel,
            deltaText,
            outputText,
            ...(firstChoice?.finish_reason !== undefined
              ? {
                  finishReason: firstChoice.finish_reason
                }
              : {}),
            ...(nextUsage ? { usage: nextUsage } : {}),
            raw: chunk
          });
        }

        const response: AIChatResponse = {
          provider: this.provider,
          model: resolvedModel,
          outputText,
          message: {
            role: "assistant",
            content: outputText
          },
          finishReason: finishReason ?? null,
          ...(usage ? { usage } : {}),
          raw: {
            chunks: rawChunks
          }
        };

        queue.close();
        return response;
      } catch (error) {
        queue.fail(error);
        throw error;
      }
    })();

    return {
      [Symbol.asyncIterator]() {
        return queue[Symbol.asyncIterator]();
      },
      finalResponse
    };
  }
}

export function createOpenAICompatibleChatProvider(
  options?: OpenAICompatibleChatProviderOptions
): AIProvider {
  return new OpenAICompatibleChatProvider(options);
}

export function createOpenAIChatProvider(
  options?: OpenAIChatProviderOptions
): AIProvider {
  return createOpenAICompatibleChatProvider(options);
}
