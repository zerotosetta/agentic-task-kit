import type {
  AIChatRequest,
  AIChatResponse,
  AIChatStream,
  AIProvider,
  WorkflowContext,
} from "../types.js";
import { toSerializableValue } from "../workflow-input.js";

function clipMonitoringText(value: string, maxLength = 160): string {
  if (value.length <= maxLength) {
    return value;
  }

  if (maxLength <= 3) {
    return value.slice(0, maxLength);
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function stringifyMessageContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }

        if (entry && typeof entry === "object" && "text" in entry) {
          return String((entry as { text?: unknown }).text ?? "");
        }

        return JSON.stringify(toSerializableValue(entry));
      })
      .join("\n");
  }

  if (content === undefined || content === null) {
    return "";
  }

  return String(content);
}

function buildPromptMonitoringMeta(
  provider: AIProvider,
  request: AIChatRequest,
): Record<string, unknown> {
  const messages = request.messages ?? [];
  const nativePrompt = request.payload
    ? JSON.stringify(toSerializableValue(request.payload))
    : "";
  const fullPrompt =
    nativePrompt ||
    messages
      .map(
        (message) =>
          `${message.role}: ${stringifyMessageContent(message.content)}`,
      )
      .join("\n");
  const userPrompt =
    nativePrompt ||
    messages
      .filter((message) => message.role === "user")
      .map((message) => stringifyMessageContent(message.content))
      .join("\n");
  const prompt = userPrompt || fullPrompt;

  return {
    provider: provider.provider,
    model:
      typeof request.payload?.model === "string"
        ? request.payload.model
        : (request.model ?? provider.defaultChatModel ?? "unconfigured"),
    ...(provider.apiType ? { apiType: provider.apiType } : {}),
    messageCount: messages.length,
    promptLength: prompt.length,
    fullPromptLength: fullPrompt.length,
    prompt: clipMonitoringText(prompt),
  };
}

function buildResponseMonitoringMeta(
  response: AIChatResponse,
): Record<string, unknown> {
  return {
    provider: response.provider,
    model: response.model,
    outputLength: response.outputText.length,
    output: clipMonitoringText(response.outputText),
    ...(response.finishReason ? { finishReason: response.finishReason } : {}),
    ...(response.usage?.inputTokens !== undefined
      ? { inputTokens: response.usage.inputTokens }
      : {}),
    ...(response.usage?.outputTokens !== undefined
      ? { outputTokens: response.usage.outputTokens }
      : {}),
    ...(response.usage?.totalTokens !== undefined
      ? { totalTokens: response.usage.totalTokens }
      : {}),
  };
}

function errorMessageForMonitoring(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function createObservedAIProvider(
  provider: AIProvider,
  log: WorkflowContext["log"],
): AIProvider {
  return {
    provider: provider.provider,
    ...(provider.apiType ? { apiType: provider.apiType } : {}),
    defaultChatModel: provider.defaultChatModel,
    async chat(request) {
      const requestMeta = buildPromptMonitoringMeta(provider, request);
      log.info("AI chat request", requestMeta);

      try {
        const response = await provider.chat(request);
        log.success("AI chat response", {
          ...requestMeta,
          ...buildResponseMonitoringMeta(response),
        });
        return response;
      } catch (error) {
        log.error("AI chat failed", {
          ...requestMeta,
          errorMessage: errorMessageForMonitoring(error),
        });
        throw error;
      }
    },
    async chatStream(request): Promise<AIChatStream> {
      const requestMeta = buildPromptMonitoringMeta(provider, request);
      log.info("AI chat stream request", requestMeta);

      try {
        const stream = await provider.chatStream(request);
        const finalResponse = stream.finalResponse.then(
          (response) => {
            log.success("AI chat stream response", {
              ...requestMeta,
              ...buildResponseMonitoringMeta(response),
            });
            return response;
          },
          (error) => {
            log.error("AI chat stream failed", {
              ...requestMeta,
              errorMessage: errorMessageForMonitoring(error),
            });
            throw error;
          },
        );

        void finalResponse.catch(() => undefined);
        return {
          [Symbol.asyncIterator]() {
            return stream[Symbol.asyncIterator]();
          },
          finalResponse,
        };
      } catch (error) {
        log.error("AI chat stream failed", {
          ...requestMeta,
          errorMessage: errorMessageForMonitoring(error),
        });
        throw error;
      }
    },
  };
}
