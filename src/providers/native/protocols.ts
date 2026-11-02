import { AIProviderRequestError } from "../../errors.js";
import type {
  AIAPIType,
  AIChatRequest,
  AIChatResponse,
  AIChatUsage,
  AISessionMessage,
  AIChatContentPart,
  AIProviderOptions,
} from "../../types.js";
import { mergePayload } from "../payload.js";

export type NativeAPIType = Exclude<
  AIAPIType,
  "openai-chat-completions" | "webchat"
>;
export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
function textParts(value: unknown): string {
  return array(value)
    .filter((part) => object(part).thought !== true)
    .map((part) => text(object(part).text))
    .join("");
}
function systemText(message: AISessionMessage): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .map((part) => {
      if ("text" in part) return part.text;
      throw new Error(
        "System/developer images require a native payload supported by the selected API.",
      );
    })
    .join("\n");
}
function imageURL(part: AIChatContentPart): string {
  if ("text" in part) return "";
  const url =
    typeof part.image_url === "string"
      ? part.image_url
      : (part.image_url?.url ?? part.imageUrl);
  if (!url)
    throw new Error("AI image content requires imageUrl or image_url.url.");
  return url;
}
function content(message: AISessionMessage, apiType: NativeAPIType): unknown {
  if (typeof message.content === "string") {
    return apiType === "gemini-generate-content"
      ? [{ text: message.content }]
      : message.content;
  }
  return message.content.map((part) => {
    if ("text" in part) {
      if (apiType === "gemini-generate-content") return { text: part.text };
      return {
        type: apiType === "openai-responses" ? "input_text" : "text",
        text: part.text,
      };
    }
    const url = imageURL(part);
    if (apiType === "openai-responses") {
      const detail =
        part.detail ??
        (typeof part.image_url === "object"
          ? part.image_url.detail
          : undefined);
      return {
        type: "input_image",
        image_url: url,
        ...(detail ? { detail } : {}),
      };
    }
    const data = /^data:([^;,]+);base64,(.+)$/su.exec(url);
    if (apiType === "anthropic-messages") {
      return {
        type: "image",
        source: data
          ? { type: "base64", media_type: data[1], data: data[2] }
          : { type: "url", url },
      };
    }
    return data
      ? { inlineData: { mimeType: data[1], data: data[2] } }
      : { fileData: { fileUri: url } };
  });
}

export function buildNativeBody(
  apiType: NativeAPIType,
  model: string,
  request: AIChatRequest,
  options: AIProviderOptions,
  streaming: boolean,
): Record<string, unknown> {
  let mapped: Record<string, unknown> = {};
  if (request.payloadMode !== "replace") {
    const messages = request.messages;
    const temperature = request.temperature ?? options.defaultTemperature;
    const maxTokens =
      request.maxCompletionTokens ?? options.defaultMaxCompletionTokens;
    const effort = request.reasoningEffort ?? options.defaultReasoningEffort;
    if (apiType === "openai-responses") {
      mapped = {
        model,
        ...(messages
          ? {
              input: messages.map((message) => ({
                role: message.role,
                content: content(message, apiType),
              })),
            }
          : {}),
        ...(temperature !== undefined ? { temperature } : {}),
        ...(maxTokens !== undefined ? { max_output_tokens: maxTokens } : {}),
        ...(effort !== undefined ? { reasoning: { effort } } : {}),
        ...(request.metadata ? { metadata: request.metadata } : {}),
        ...(request.promptCacheKey
          ? { prompt_cache_key: request.promptCacheKey }
          : {}),
      };
    } else {
      const system = messages
        ?.filter(
          (message) =>
            message.role === "system" || message.role === "developer",
        )
        .map(systemText)
        .join("\n");
      const conversation = messages?.filter(
        (message) => message.role !== "system" && message.role !== "developer",
      );
      if (apiType === "anthropic-messages") {
        mapped = {
          model,
          // Messages requires a token limit; a native payload can override it.
          max_tokens: maxTokens ?? options.defaultPayload?.max_tokens ?? 1024,
          ...(system ? { system } : {}),
          ...(conversation
            ? {
                messages: conversation.map((message) => ({
                  role: message.role,
                  content: content(message, apiType),
                })),
              }
            : {}),
          ...(temperature !== undefined ? { temperature } : {}),
        };
      } else {
        mapped = {
          ...(system
            ? { systemInstruction: { parts: [{ text: system }] } }
            : {}),
          ...(conversation
            ? {
                contents: conversation.map((message) => ({
                  role: message.role === "assistant" ? "model" : "user",
                  parts: content(message, apiType),
                })),
              }
            : {}),
        };
        if (temperature !== undefined || maxTokens !== undefined) {
          mapped.generationConfig = {
            ...(temperature !== undefined ? { temperature } : {}),
            ...(maxTokens !== undefined ? { maxOutputTokens: maxTokens } : {}),
          };
        }
      }
    }
  }
  const body = mergePayload(request, options.defaultPayload, mapped);
  if (apiType !== "gemini-generate-content") body.stream = streaming;
  return body;
}

export function nativeError(
  provider: string,
  model: string,
  raw: unknown,
  response?: Response,
): AIProviderRequestError {
  const error = object(object(raw).error ?? raw);
  return new AIProviderRequestError({
    provider,
    model,
    ...(response
      ? {
          status: response.status,
          requestId:
            response.headers.get("x-request-id") ??
            response.headers.get("request-id"),
        }
      : {}),
    ...(typeof error.code === "string" ? { code: error.code } : {}),
    ...(typeof error.type === "string" ? { type: error.type } : {}),
    responseBody: raw,
    originalError: new Error(
      text(error.message) ||
        `AI API request failed${response ? ` (${response.status})` : ""}.`,
    ),
  });
}

export function nativeUsage(
  apiType: NativeAPIType,
  raw: unknown,
): AIChatUsage | undefined {
  const value = object(raw);
  const fields =
    apiType === "gemini-generate-content"
      ? {
          inputTokens: value.promptTokenCount,
          outputTokens: value.candidatesTokenCount,
          totalTokens: value.totalTokenCount,
          reasoningTokens: value.thoughtsTokenCount,
        }
      : {
          inputTokens: value.input_tokens,
          outputTokens: value.output_tokens,
          totalTokens: value.total_tokens,
          reasoningTokens: object(value.output_tokens_details).reasoning_tokens,
        };
  const usage = Object.fromEntries(
    Object.entries(fields).filter(([, count]) => typeof count === "number"),
  ) as AIChatUsage;
  return Object.keys(usage).length ? usage : undefined;
}

export function parseNativeResponse(
  apiType: NativeAPIType,
  provider: string,
  model: string,
  raw: unknown,
): AIChatResponse {
  const value = object(raw);
  if (value.error || value.status === "failed" || value.status === "cancelled")
    throw nativeError(provider, model, raw);
  let outputText: string;
  let finishReason: string;
  if (apiType === "openai-responses") {
    if (!Array.isArray(value.output) && typeof value.output_text !== "string")
      throw new Error("Invalid Responses API response: missing output.");
    outputText =
      typeof value.output_text === "string"
        ? value.output_text
        : array(value.output)
            .map((item) => textParts(object(item).content))
            .join("");
    finishReason =
      text(object(value.incomplete_details).reason) ||
      text(value.status) ||
      "completed";
  } else if (apiType === "anthropic-messages") {
    if (!Array.isArray(value.content))
      throw new Error("Invalid Messages API response: missing content.");
    outputText = textParts(value.content);
    finishReason = text(value.stop_reason);
  } else {
    if (!Array.isArray(value.candidates) && !value.promptFeedback)
      throw new Error("Invalid Gemini response: missing candidates.");
    const candidate = object(array(value.candidates)[0]);
    outputText = textParts(object(candidate.content).parts);
    finishReason =
      text(candidate.finishReason) ||
      text(object(value.promptFeedback).blockReason);
  }
  const usage = nativeUsage(apiType, value.usage ?? value.usageMetadata);
  return {
    provider,
    model: text(value.model) || text(value.modelVersion) || model,
    outputText,
    message: { role: "assistant", content: outputText },
    finishReason: finishReason || null,
    ...(usage ? { usage } : {}),
    raw,
  };
}

export type StreamUpdate = {
  deltaText: string;
  model?: string;
  usage?: AIChatUsage | undefined;
  finishReason?: string;
  terminal?: boolean;
  response?: AIChatResponse;
};
export function parseNativeEvent(
  apiType: NativeAPIType,
  provider: string,
  model: string,
  raw: unknown,
  eventName?: string,
): StreamUpdate {
  const value = object(raw);
  const type = text(value.type) || eventName;
  if (value.error || type === "error" || type === "response.failed")
    throw nativeError(provider, model, value.response ?? raw);
  if (apiType === "openai-responses") {
    if (type === "response.completed" || type === "response.incomplete") {
      return {
        deltaText: "",
        terminal: true,
        response: parseNativeResponse(apiType, provider, model, value.response),
      };
    }
    return {
      deltaText: type === "response.output_text.delta" ? text(value.delta) : "",
      ...(text(object(value.response).model)
        ? { model: text(object(value.response).model) }
        : {}),
    };
  }
  if (apiType === "anthropic-messages") {
    const message = object(value.message);
    const delta = object(value.delta);
    return {
      deltaText:
        type === "content_block_start"
          ? text(object(value.content_block).text)
          : type === "content_block_delta" && delta.type === "text_delta"
            ? text(delta.text)
            : "",
      ...(text(message.model) ? { model: text(message.model) } : {}),
      usage: nativeUsage(apiType, value.usage ?? message.usage),
      ...(text(delta.stop_reason)
        ? { finishReason: text(delta.stop_reason) }
        : {}),
      terminal: type === "message_stop",
    };
  }
  const candidate = object(array(value.candidates)[0]);
  const finishReason =
    text(candidate.finishReason) ||
    text(object(value.promptFeedback).blockReason);
  return {
    deltaText: textParts(object(candidate.content).parts),
    ...(text(value.modelVersion) ? { model: text(value.modelVersion) } : {}),
    usage: nativeUsage(apiType, value.usageMetadata),
    ...(finishReason ? { finishReason, terminal: true } : {}),
  };
}
