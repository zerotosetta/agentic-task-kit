import OpenAI from "openai";
import { mergePayload } from "../payload.js";
import type {
  AIChatContentPart,
  AIChatRequest,
  AIChatUsage,
  AIHTTPHeaders,
  AISessionMessage,
  OpenAICompatibleChatProviderOptions,
} from "../../types.js";

function isTextContentPart(
  part: AIChatContentPart,
): part is Extract<AIChatContentPart, { type: "text" | "input_text" }> {
  return part.type === "text" || part.type === "input_text";
}

function toOpenAITextContentPart(
  part: Extract<AIChatContentPart, { type: "text" | "input_text" }>,
): OpenAI.ChatCompletionContentPartText {
  return {
    type: "text",
    text: part.text,
  };
}

function toOpenAIUserContentPart(
  part: AIChatContentPart,
):
  | OpenAI.Chat.Completions.ChatCompletionContentPartText
  | OpenAI.Chat.Completions.ChatCompletionContentPartImage {
  if (isTextContentPart(part)) {
    return toOpenAITextContentPart(part);
  }

  const imageURL =
    typeof part.image_url === "string"
      ? {
          url: part.image_url,
          ...(part.detail ? { detail: part.detail } : {}),
        }
      : part.image_url
        ? part.image_url
        : part.imageUrl
          ? {
              url: part.imageUrl,
              ...(part.detail ? { detail: part.detail } : {}),
            }
          : undefined;

  if (!imageURL?.url) {
    throw new Error(
      "AI chat image_url content part requires `imageUrl` or `image_url.url`.",
    );
  }

  return {
    type: "image_url",
    image_url: imageURL,
  };
}

function toOpenAIMessage(
  message: AISessionMessage,
): OpenAI.ChatCompletionMessageParam {
  if (message.role === "assistant") {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => {
            if (!isTextContentPart(part)) {
              throw new Error(
                'OpenAI-compatible chat message role "assistant" only supports text content parts.',
              );
            }

            return toOpenAITextContentPart(part);
          });
    return {
      role: "assistant",
      content,
    };
  }

  if (message.role === "developer") {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => {
            if (!isTextContentPart(part)) {
              throw new Error(
                'OpenAI-compatible chat message role "developer" only supports text content parts.',
              );
            }

            return toOpenAITextContentPart(part);
          });
    return message.name
      ? {
          role: "developer",
          content,
          name: message.name,
        }
      : {
          role: "developer",
          content,
        };
  }

  if (message.role === "system") {
    const content =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => {
            if (!isTextContentPart(part)) {
              throw new Error(
                'OpenAI-compatible chat message role "system" only supports text content parts.',
              );
            }

            return toOpenAITextContentPart(part);
          });
    return message.name
      ? {
          role: "system",
          content,
          name: message.name,
        }
      : {
          role: "system",
          content,
        };
  }

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content.map(toOpenAIUserContentPart);
  return message.name
    ? {
        role: "user",
        content,
        name: message.name,
      }
    : {
        role: "user",
        content,
      };
}

export function extractText(content: unknown): string {
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

export function toUsage(usage: unknown): AIChatUsage | undefined {
  if (!usage || typeof usage !== "object") {
    return undefined;
  }

  const promptTokens =
    "prompt_tokens" in usage && typeof usage.prompt_tokens === "number"
      ? usage.prompt_tokens
      : undefined;
  const completionTokens =
    "completion_tokens" in usage && typeof usage.completion_tokens === "number"
      ? usage.completion_tokens
      : undefined;
  const totalTokens =
    "total_tokens" in usage && typeof usage.total_tokens === "number"
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
    ...(completionTokens !== undefined
      ? { outputTokens: completionTokens }
      : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

export function buildRequestOptions(request: AIChatRequest) {
  const requestOptions: {
    headers?: AIHTTPHeaders;
    timeout?: number;
    maxRetries?: number;
    defaultBaseURL?: string;
    signal?: AbortSignal;
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

  if (request.http?.signal !== undefined) {
    requestOptions.signal = request.http.signal;
  }

  return requestOptions;
}

export function buildNonStreamingBody(
  model: string,
  request: AIChatRequest,
  defaults: {
    defaultTemperature: number | undefined;
    defaultMaxCompletionTokens: number | undefined;
    defaultReasoningEffort:
      OpenAICompatibleChatProviderOptions["defaultReasoningEffort"] | undefined;
    defaultPayload?: Record<string, unknown> | undefined;
  },
): OpenAI.ChatCompletionCreateParamsNonStreaming {
  const resolvedTemperature =
    request.temperature ?? defaults.defaultTemperature;
  const resolvedMaxCompletionTokens =
    request.maxCompletionTokens ?? defaults.defaultMaxCompletionTokens;
  const resolvedReasoningEffort =
    request.reasoningEffort ?? defaults.defaultReasoningEffort;

  const body: Record<string, unknown> = {
    model,
    ...(request.messages !== undefined && request.payloadMode !== "replace"
      ? { messages: request.messages.map(toOpenAIMessage) }
      : {}),
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

  const merged = mergePayload(request, defaults.defaultPayload, body);
  // The operation owns the transport mode; all other native fields pass through.
  if ("stream" in merged) merged.stream = false;
  return merged as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming;
}

export function buildStreamingBody(
  model: string,
  request: AIChatRequest,
  defaults: {
    defaultTemperature: number | undefined;
    defaultMaxCompletionTokens: number | undefined;
    defaultReasoningEffort:
      OpenAICompatibleChatProviderOptions["defaultReasoningEffort"] | undefined;
    defaultPayload?: Record<string, unknown> | undefined;
  },
): OpenAI.ChatCompletionCreateParamsStreaming {
  return {
    ...buildNonStreamingBody(model, request, defaults),
    stream: true,
  };
}
