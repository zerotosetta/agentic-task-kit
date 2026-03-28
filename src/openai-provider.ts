import OpenAI, { type ClientOptions } from "openai";

import type {
  AIChatRequest,
  AIChatResponse,
  AIProvider,
  AISessionMessage,
  OpenAIChatProviderOptions
} from "./types.js";

type ResolvedOpenAIChatProviderOptions = {
  apiKey: string | undefined;
  baseURL: string | undefined;
  organization: string | undefined;
  project: string | undefined;
  defaultModel: string | undefined;
  timeoutMs: number | undefined;
  maxRetries: number | undefined;
  defaultTemperature: number | undefined;
  defaultMaxCompletionTokens: number | undefined;
  defaultReasoningEffort: OpenAIChatProviderOptions["defaultReasoningEffort"] | undefined;
};

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function resolveOptions(
  options: OpenAIChatProviderOptions = {}
): ResolvedOpenAIChatProviderOptions {
  return {
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    baseURL: options.baseURL ?? process.env.OPENAI_BASE_URL,
    organization: options.organization ?? process.env.OPENAI_ORG_ID,
    project: options.project ?? process.env.OPENAI_PROJECT_ID,
    defaultModel: options.defaultModel ?? process.env.OPENAI_MODEL,
    timeoutMs: options.timeoutMs ?? parseOptionalInteger(process.env.OPENAI_TIMEOUT_MS),
    maxRetries: options.maxRetries ?? parseOptionalInteger(process.env.OPENAI_MAX_RETRIES),
    defaultTemperature: options.defaultTemperature,
    defaultMaxCompletionTokens:
      options.defaultMaxCompletionTokens ??
      parseOptionalInteger(process.env.OPENAI_MAX_COMPLETION_TOKENS),
    defaultReasoningEffort:
      options.defaultReasoningEffort ??
      (process.env.OPENAI_REASONING_EFFORT as OpenAIChatProviderOptions["defaultReasoningEffort"])
  };
}

function createClientOptions(
  options: ResolvedOpenAIChatProviderOptions
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

function extractOutputText(content: unknown): string {
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
    .join("")
    .trim();
}

class OpenAIChatProvider implements AIProvider {
  readonly provider = "openai-chat-completions";
  readonly defaultChatModel: string | undefined;

  private readonly client: OpenAI;
  private readonly defaultTemperature: number | undefined;
  private readonly defaultMaxCompletionTokens: number | undefined;
  private readonly defaultReasoningEffort: OpenAIChatProviderOptions["defaultReasoningEffort"] | undefined;

  constructor(options: OpenAIChatProviderOptions = {}) {
    const resolved = resolveOptions(options);
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
        "No OpenAI chat model configured. Set `defaultModel` in `createOpenAIChatProvider()` or pass `model` to `ctx.ai.chat()`."
      );
    }

    const resolvedTemperature = request.temperature ?? this.defaultTemperature;
    const resolvedMaxCompletionTokens =
      request.maxCompletionTokens ?? this.defaultMaxCompletionTokens;
    const resolvedReasoningEffort =
      request.reasoningEffort ?? this.defaultReasoningEffort;

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

    const completion = await this.client.chat.completions.create(body);

    const firstChoice = completion.choices[0];
    const outputText = extractOutputText(firstChoice?.message.content);

    const usage = completion.usage
      ? {
          inputTokens: completion.usage.prompt_tokens,
          outputTokens: completion.usage.completion_tokens,
          totalTokens: completion.usage.total_tokens,
          ...(completion.usage.completion_tokens_details?.reasoning_tokens !== undefined
            ? {
                reasoningTokens:
                  completion.usage.completion_tokens_details.reasoning_tokens
              }
            : {})
        }
      : undefined;

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
}

export function createOpenAIChatProvider(
  options?: OpenAIChatProviderOptions
): AIProvider {
  return new OpenAIChatProvider(options);
}
