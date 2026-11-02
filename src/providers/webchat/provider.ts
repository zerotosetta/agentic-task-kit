import { setTimeout as delay } from "node:timers/promises";
import { AIProviderRequestError } from "../../errors.js";
import { combineAbortSignals } from "../../shared/abort.js";
import type {
  AIChatRequest,
  AIChatResponse,
  AIChatStream,
  AIChatStreamChunk,
  AIHTTPRequestOptions,
  WebChatAIProvider,
  WebChatAIProviderOptions,
  WebChatCompletionContext,
  WebChatSession,
} from "../../types.js";
import { AsyncQueue } from "../openai/queue.js";
import { toProviderRequestError } from "../openai/errors.js";
import {
  WebChatClient,
  abortable,
  validateEndpoint,
  type Operation,
} from "./client.js";
import {
  buildMessages,
  extractAssistant,
  record,
  submittedMessageId,
  valueAt,
} from "./messages.js";

class SessionWebChatProvider implements WebChatAIProvider {
  readonly apiType = "webchat" as const;
  readonly provider: string;
  readonly defaultChatModel: string | undefined;
  private readonly client: WebChatClient;
  private readonly queues = new Map<string, Promise<void>>();
  constructor(private readonly options: WebChatAIProviderOptions) {
    this.provider = options.providerName ?? "webchat";
    this.defaultChatModel = options.defaultModel ?? process.env.WEBCHAT_MODEL;
    this.client = new WebChatClient(options, this.provider);
    const count = options.webChat?.maxSessionCount;
    if (count !== undefined && (!Number.isInteger(count) || count < 1))
      throw new Error("WebChat maxSessionCount must be a positive integer.");
  }
  private model(request: AIChatRequest) {
    return request.model ?? this.defaultChatModel ?? "unconfigured";
  }
  private sessionKey(request: AIChatRequest, sessionId: string): string {
    const base = new URL(request.http?.baseURL ?? this.client.baseURL);
    if (!base.pathname.endsWith("/")) base.pathname += "/";
    return `${base.href}|${sessionId}`;
  }
  private async create(
    request: AIChatRequest,
    operation: Operation,
  ): Promise<WebChatSession> {
    const settings = this.options.webChat ?? {};
    const body = {
      title: request.webChat?.title ?? settings.title ?? "agentic-task-kit",
      assistant_uuid:
        request.webChat?.assistantUUID ??
        settings.assistantUUID ??
        process.env.WEBCHAT_ASSISTANT_UUID,
      llm_id: request.model ?? this.defaultChatModel,
      ...settings.sessionPayload,
      ...request.webChat?.sessionPayload,
    };
    if (
      typeof body.assistant_uuid !== "string" ||
      !body.assistant_uuid ||
      typeof body.llm_id !== "string" ||
      !body.llm_id
    )
      throw new Error(
        "Creating a WebChat session requires assistantUUID and defaultModel/request.model (or sessionPayload assistant_uuid/llm_id).",
      );
    operation.model = body.llm_id;
    const raw = await operation.send(
      {
        path: settings.createSessionPath ?? "/action-webchat/post/sessions",
        method: "POST",
        payload: body,
      },
      {},
      true,
    );
    const sessionId = valueAt(raw, settings.sessionIdPath ?? ["session_id"]);
    if (typeof sessionId !== "string" || !sessionId)
      throw new Error(
        "WebChat createSession response has no valid session_id. Configure sessionIdPath for a different schema.",
      );
    return {
      sessionId,
      model:
        typeof record(raw).llm_id === "string"
          ? (record(raw).llm_id as string)
          : body.llm_id,
      raw,
    };
  }
  async createSession(request: AIChatRequest = {}): Promise<WebChatSession> {
    const operation = this.client.operation(request, this.model(request));
    try {
      return await this.create(request, operation);
    } catch (error) {
      throw toProviderRequestError(this.provider, operation.model, error);
    }
  }
  async appendMessage(
    sessionId: string,
    message: Record<string, unknown>,
    http?: AIHTTPRequestOptions,
  ): Promise<unknown> {
    if (!sessionId)
      throw new Error("WebChat appendMessage requires sessionId.");
    const request: AIChatRequest = { ...(http ? { http } : {}) };
    const operation = this.client.operation(request, this.model(request));
    try {
      return await this.serialized(
        this.sessionKey(request, sessionId),
        operation,
        () => this.append(sessionId, message, operation),
      );
    } catch (error) {
      throw toProviderRequestError(this.provider, operation.model, error);
    }
  }
  private append(
    sessionId: string,
    message: Record<string, unknown>,
    operation: Operation,
  ) {
    return operation.send(
      {
        path:
          this.options.webChat?.appendMessagePath ??
          "/action-webchat/post/sessions/{sessionId}/messages",
        method: "POST",
        payload: message,
      },
      { sessionId },
    );
  }
  private async serialized<T>(
    key: string,
    operation: Operation,
    run: () => Promise<T>,
  ): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => gate);
    this.queues.set(key, tail);
    try {
      await abortable(previous, operation.signal);
      operation.signal.throwIfAborted();
      return await run();
    } finally {
      release();
      void tail.then(() => {
        if (this.queues.get(key) === tail) this.queues.delete(key);
      });
    }
  }
  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const settings = this.options.webChat ?? {};
    const completion = settings.completion;
    if (
      !completion ||
      !["append", "request", "poll", "custom"].includes(completion.mode)
    )
      throw new Error(
        "WebChat chat requires an explicit completion mode. The HAR only confirmed session creation/message registration; configure request/poll/custom for the real answer API, or append for an API returning inline assistant replies.",
      );
    if (completion.mode === "poll") {
      if (
        !Number.isInteger(completion.maxAttempts ?? 120) ||
        (completion.maxAttempts ?? 120) < 1 ||
        !Number.isInteger(completion.intervalMs ?? 500) ||
        (completion.intervalMs ?? 500) < 0
      )
        throw new Error(
          "WebChat polling requires positive maxAttempts and non-negative intervalMs integers.",
        );
    }
    if (
      completion.mode === "custom" &&
      typeof completion.complete !== "function"
    )
      throw new Error(
        "WebChat custom completion requires a complete callback.",
      );
    if (completion.mode === "request" || completion.mode === "poll")
      validateEndpoint(completion);
    if (completion.mode === "poll" && completion.trigger)
      validateEndpoint(completion.trigger);
    const messages = buildMessages(request, this.options.defaultPayload);
    const operation = this.client.operation(request, this.model(request));
    const sessionId = request.webChat?.sessionId ?? settings.sessionId;
    if (
      sessionId !== undefined &&
      (typeof sessionId !== "string" || !sessionId)
    )
      throw new Error("WebChat sessionId must be a non-empty string.");
    const run = async () => {
      const session: WebChatSession = sessionId
        ? { sessionId, model: operation.model, raw: null }
        : await this.create(request, operation);
      operation.model = session.model;
      const postedResponses: unknown[] = [];
      for (const message of messages) {
        const raw = await this.append(session.sessionId, message, operation);
        postedResponses.push(raw);
        if (typeof record(raw).llm_id === "string")
          session.model = record(raw).llm_id as string;
        operation.model = session.model;
      }
      const lastMessage = messages.at(-1)!;
      const lastResponse = postedResponses.at(-1);
      const messageId = submittedMessageId(lastResponse, lastMessage);
      const assistantUUID =
        record(lastResponse).assistant_uuid ??
        record(session.raw).assistant_uuid ??
        request.webChat?.sessionPayload?.assistant_uuid ??
        settings.sessionPayload?.assistant_uuid ??
        request.webChat?.assistantUUID ??
        settings.assistantUUID ??
        process.env.WEBCHAT_ASSISTANT_UUID;
      const context: WebChatCompletionContext = {
        session,
        request,
        lastMessage,
        ...(messageId !== undefined ? { messageId } : {}),
        postedResponses,
        signal: operation.signal,
        send: (endpoint) =>
          operation.send(endpoint, {
            sessionId: session.sessionId,
            ...(messageId !== undefined ? { messageId } : {}),
            model: session.model,
            ...(typeof assistantUUID === "string" && assistantUUID
              ? { assistantUUID }
              : {}),
          }),
      };
      let raw: unknown = lastResponse;
      const attempts =
        completion.mode === "poll" ? (completion.maxAttempts ?? 120) : 1;
      if (completion.mode === "poll" && completion.trigger)
        await context.send(completion.trigger);
      for (let attempt = 0; attempt < attempts; attempt++) {
        operation.signal.throwIfAborted();
        if (completion.mode === "request" || completion.mode === "poll")
          raw = await context.send(completion);
        else if (completion.mode === "custom")
          raw = await abortable(
            Promise.resolve(completion.complete(context)),
            operation.signal,
          );
        operation.signal.throwIfAborted();
        const answer = extractAssistant(raw, context, settings);
        if (answer) {
          if (typeof answer.text !== "string")
            throw new Error(
              "WebChat extractAssistant must return text as a string.",
            );
          return {
            provider: this.provider,
            model: session.model,
            outputText: answer.text,
            message: { role: "assistant" as const, content: answer.text },
            finishReason: answer.finishReason ?? "stop",
            ...(answer.usage ? { usage: answer.usage } : {}),
            raw: {
              session_id: session.sessionId,
              session: session.raw,
              postedResponses,
              completion: raw,
              buffered: true,
            },
          };
        }
        if (completion.mode === "poll" && attempt + 1 < attempts)
          await delay(completion.intervalMs ?? 500, undefined, {
            signal: operation.signal,
          });
      }
      throw new AIProviderRequestError({
        provider: this.provider,
        model: session.model,
        code: "webchat_response_pending",
        responseBody: { session_id: session.sessionId, response: raw },
        originalError: new Error(
          "WebChat returned no new assistant answer. A user-message acknowledgement is not a model response; check the configured completion endpoint/parser.",
        ),
      });
    };
    try {
      return await (sessionId
        ? this.serialized(this.sessionKey(request, sessionId), operation, run)
        : run());
    } catch (error) {
      throw toProviderRequestError(this.provider, operation.model, error);
    }
  }
  async chatStream(request: AIChatRequest): Promise<AIChatStream> {
    const cancellation = new AbortController();
    const queue = new AsyncQueue<AIChatStreamChunk>(() => cancellation.abort());
    const pending = this.chat({
      ...request,
      http: {
        ...request.http,
        signal: combineAbortSignals([
          request.http?.signal,
          cancellation.signal,
        ])!,
      },
    });
    const finalResponse = pending.then(
      (response) => {
        queue.push({
          provider: response.provider,
          model: response.model,
          deltaText: response.outputText,
          outputText: response.outputText,
          ...(response.finishReason !== undefined
            ? { finishReason: response.finishReason }
            : {}),
          ...(response.usage ? { usage: response.usage } : {}),
          raw: response.raw,
        });
        queue.close();
        return response;
      },
      (error) => {
        queue.fail(error);
        throw error;
      },
    );
    void finalResponse.catch(() => undefined);
    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      finalResponse,
    };
  }
}

export function createWebChatAIProvider(
  options: WebChatAIProviderOptions = {},
): WebChatAIProvider {
  return new SessionWebChatProvider(options);
}
