import type {
  AIChatRequest,
  AIChatResponse,
  AIChatStream,
  AIChatStreamChunk,
  AIChatUsage,
  AIProvider,
  AIProviderOptions,
} from "../../types.js";
import { combineAbortSignals } from "../../shared/abort.js";
import { AsyncQueue } from "../openai/queue.js";
import {
  toProviderRequestError,
  writeProviderErrorDebugLog,
} from "../openai/errors.js";
import { resolveHTTPDebugLogging } from "../openai/http.js";
import { resolveRequestModel } from "../payload.js";
import {
  buildNativeBody,
  parseNativeEvent,
  parseNativeResponse,
  type NativeAPIType,
} from "./protocols.js";
import {
  nativeSettings,
  readServerEvents,
  sendNativeRequest,
} from "./transport.js";

class NativeAIProvider implements AIProvider {
  readonly apiType: NativeAPIType;
  readonly provider: string;
  readonly defaultChatModel: string | undefined;
  constructor(private readonly options: AIProviderOptions) {
    const apiType = options.apiType;
    if (
      apiType !== "openai-responses" &&
      apiType !== "anthropic-messages" &&
      apiType !== "gemini-generate-content"
    )
      throw new Error(`Unsupported AI apiType: ${String(apiType)}`);
    this.apiType = apiType;
    this.provider = options.providerName ?? apiType;
    this.defaultChatModel = nativeSettings(apiType, options).defaultModel;
  }
  private model(request: AIChatRequest): string {
    const model = resolveRequestModel(
      request,
      this.defaultChatModel,
      this.options.defaultPayload,
    );
    if (!model)
      throw new Error(
        "No AI model configured. Set defaultModel, request.model, or payload.model.",
      );
    return model;
  }
  private failure(model: string, error: unknown) {
    const failure = toProviderRequestError(this.provider, model, error);
    writeProviderErrorDebugLog(
      resolveHTTPDebugLogging(this.options.httpDebugLogging),
      this.provider,
      model,
      failure,
    );
    return failure;
  }
  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const model = this.model(request);
    try {
      const body = buildNativeBody(
        this.apiType,
        model,
        request,
        this.options,
        false,
      );
      const { response, signal } = await sendNativeRequest(
        this.apiType,
        this.provider,
        model,
        request,
        this.options,
        body,
        false,
      );
      const raw: unknown = await response.json();
      signal?.throwIfAborted();
      return parseNativeResponse(this.apiType, this.provider, model, raw);
    } catch (error) {
      throw this.failure(model, error);
    }
  }
  async chatStream(request: AIChatRequest): Promise<AIChatStream> {
    const model = this.model(request);
    const cancellation = new AbortController();
    const streamRequest: AIChatRequest = {
      ...request,
      http: {
        ...request.http,
        signal: combineAbortSignals([
          request.http?.signal,
          cancellation.signal,
        ])!,
      },
    };
    const queue = new AsyncQueue<AIChatStreamChunk>(() => cancellation.abort());
    const finalResponse = (async (): Promise<AIChatResponse> => {
      try {
        const body = buildNativeBody(
          this.apiType,
          model,
          request,
          this.options,
          true,
        );
        const { response, signal } = await sendNativeRequest(
          this.apiType,
          this.provider,
          model,
          streamRequest,
          this.options,
          body,
          true,
        );
        let outputText = "",
          resolvedModel = model;
        let finishReason: string | null = null;
        let usage: AIChatUsage | undefined;
        let terminal = false;
        let completed: AIChatResponse | undefined;
        const rawChunks: unknown[] = [];
        for await (const event of readServerEvents(response, signal)) {
          rawChunks.push(event.data);
          const update = parseNativeEvent(
            this.apiType,
            this.provider,
            resolvedModel,
            event.data,
            event.event,
          );
          outputText += update.deltaText;
          resolvedModel =
            update.model ?? update.response?.model ?? resolvedModel;
          finishReason =
            update.finishReason ??
            update.response?.finishReason ??
            finishReason;
          usage =
            update.usage || update.response?.usage
              ? { ...usage, ...update.usage, ...update.response?.usage }
              : usage;
          if (update.response) {
            completed = update.response;
            outputText = completed.outputText;
          }
          terminal ||= update.terminal === true;
          queue.push({
            provider: this.provider,
            model: resolvedModel,
            deltaText: update.deltaText,
            outputText,
            finishReason,
            ...(usage ? { usage } : {}),
            raw: event.data,
          });
          if (update.terminal && this.apiType !== "gemini-generate-content")
            break;
        }
        signal?.throwIfAborted();
        if (!terminal)
          throw new Error("AI stream ended before its terminal event.");
        if (completed) outputText = completed.outputText;
        if (
          usage?.inputTokens !== undefined &&
          usage.outputTokens !== undefined &&
          usage.totalTokens === undefined
        )
          usage.totalTokens = usage.inputTokens + usage.outputTokens;
        const result: AIChatResponse = {
          provider: this.provider,
          model: resolvedModel,
          outputText,
          message: { role: "assistant", content: outputText },
          finishReason,
          ...(usage ? { usage } : {}),
          raw: {
            chunks: rawChunks,
            ...(completed ? { response: completed.raw } : {}),
          },
        };
        queue.close();
        return result;
      } catch (error) {
        const failure = this.failure(model, error);
        queue.fail(failure);
        throw failure;
      }
    })();
    void finalResponse.catch(() => undefined);
    return {
      [Symbol.asyncIterator]: () => queue[Symbol.asyncIterator](),
      finalResponse,
    };
  }
}

export function createNativeAIProvider(options: AIProviderOptions): AIProvider {
  return new NativeAIProvider(options);
}
