import OpenAI from "openai";
import { combineAbortSignals } from "../../shared/abort.js";
import type {
  AIChatRequest,
  AIChatResponse,
  AIChatStream,
  AIChatStreamChunk,
  AIChatUsage,
  AIProvider,
  OpenAIChatProviderOptions,
  OpenAICompatibleChatProviderOptions,
} from "../../types.js";
import { toProviderRequestError, writeProviderErrorDebugLog } from "./errors.js";
import type { ResolvedAIHTTPDebugLoggingOptions } from "./http.js";
import {
  buildNonStreamingBody,
  buildRequestOptions,
  buildStreamingBody,
  extractText,
  toUsage,
} from "./messages.js";
import { createClientOptions, resolveOptions } from "./options.js";
import { AsyncQueue } from "./queue.js";

class OpenAICompatibleChatProvider implements AIProvider {
  readonly provider: string;
  readonly defaultChatModel: string | undefined;

  private readonly client: OpenAI;
  private readonly httpDebugLogging: ResolvedAIHTTPDebugLoggingOptions | undefined;
  private readonly defaultTemperature: number | undefined;
  private readonly defaultMaxCompletionTokens: number | undefined;
  private readonly defaultReasoningEffort:
    | OpenAICompatibleChatProviderOptions["defaultReasoningEffort"]
    | undefined;

  constructor(options: OpenAICompatibleChatProviderOptions = {}) {
    const resolved = resolveOptions(options);
    this.provider = resolved.providerName;
    this.client = new OpenAI(createClientOptions(resolved));
    this.httpDebugLogging = resolved.httpDebugLogging;
    this.defaultChatModel = resolved.defaultModel;
    this.defaultTemperature = resolved.defaultTemperature;
    this.defaultMaxCompletionTokens = resolved.defaultMaxCompletionTokens;
    this.defaultReasoningEffort = resolved.defaultReasoningEffort;
  }

  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const model = request.model ?? this.defaultChatModel;
    if (!model) {
      throw new Error(
        "No OpenAI-compatible chat model configured. Set `defaultModel` in `createOpenAICompatibleChatProvider()` or pass `model` to `ctx.ai.chat()`.",
      );
    }

    const completion = await (async () => {
      try {
        return await this.client.chat.completions.create(
          buildNonStreamingBody(model, request, {
            defaultTemperature: this.defaultTemperature,
            defaultMaxCompletionTokens: this.defaultMaxCompletionTokens,
            defaultReasoningEffort: this.defaultReasoningEffort,
          }),
          buildRequestOptions(request),
        );
      } catch (error) {
        const providerError = toProviderRequestError(this.provider, model, error);
        writeProviderErrorDebugLog(this.httpDebugLogging, this.provider, model, providerError);
        throw providerError;
      }
    })();

    const firstChoice = completion.choices[0];
    const outputText = extractText(firstChoice?.message.content).trim();
    const usage = toUsage(completion.usage);

    return {
      provider: this.provider,
      model: completion.model,
      outputText,
      message: {
        role: "assistant",
        content: outputText,
      },
      finishReason: firstChoice?.finish_reason ?? null,
      ...(usage ? { usage } : {}),
      raw: completion,
    };
  }

  async chatStream(request: AIChatRequest): Promise<AIChatStream> {
    const model = request.model ?? this.defaultChatModel;
    if (!model) {
      throw new Error(
        "No OpenAI-compatible chat model configured. Set `defaultModel` in `createOpenAICompatibleChatProvider()` or pass `model` to `ctx.ai.chatStream()`.",
      );
    }

    const cancellation = new AbortController();
    const streamRequest: AIChatRequest = {
      ...request,
      http: {
        ...request.http,
        signal: combineAbortSignals([request.http?.signal, cancellation.signal])!,
      },
    };
    const queue = new AsyncQueue<AIChatStreamChunk>(() => cancellation.abort());
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
            defaultReasoningEffort: this.defaultReasoningEffort,
          }),
          buildRequestOptions(streamRequest),
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
                  finishReason: firstChoice.finish_reason,
                }
              : {}),
            ...(nextUsage ? { usage: nextUsage } : {}),
            raw: chunk,
          });
        }

        // The SDK can end its iterator normally after an abort. A partial
        // response must not be reported as a successful completion.
        streamRequest.http?.signal?.throwIfAborted();
        const response: AIChatResponse = {
          provider: this.provider,
          model: resolvedModel,
          outputText,
          message: {
            role: "assistant",
            content: outputText,
          },
          finishReason: finishReason ?? null,
          ...(usage ? { usage } : {}),
          raw: {
            chunks: rawChunks,
          },
        };

        queue.close();
        return response;
      } catch (error) {
        const providerError = toProviderRequestError(this.provider, model, error);
        writeProviderErrorDebugLog(this.httpDebugLogging, this.provider, model, providerError);
        queue.fail(providerError);
        throw providerError;
      }
    })();

    // Iterator consumers may never await finalResponse, including early breaks.
    void finalResponse.catch(() => undefined);
    return {
      [Symbol.asyncIterator]() {
        return queue[Symbol.asyncIterator]();
      },
      finalResponse,
    };
  }
}

export function createOpenAICompatibleChatProvider(
  options?: OpenAICompatibleChatProviderOptions,
): AIProvider {
  return new OpenAICompatibleChatProvider(options);
}

export function createOpenAIChatProvider(options?: OpenAIChatProviderOptions): AIProvider {
  return createOpenAICompatibleChatProvider(options);
}
