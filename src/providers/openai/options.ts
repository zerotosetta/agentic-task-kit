import { type ClientOptions } from "openai";
import type { AIHTTPHeaders, OpenAICompatibleChatProviderOptions } from "../../types.js";
import {
  createDebugLoggingFetch,
  type ResolvedAIHTTPDebugLoggingOptions,
  resolveHTTPDebugLogging,
} from "./http.js";

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
  defaultReasoningEffort: OpenAICompatibleChatProviderOptions["defaultReasoningEffort"] | undefined;
};

function parseOptionalInteger(value: string | undefined): number | undefined {
  if (!value) {
    return undefined;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
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

export function resolveOptions(
  options: OpenAICompatibleChatProviderOptions = {},
): ResolvedOpenAICompatibleChatProviderOptions {
  return {
    providerName:
      options.providerName ?? process.env.OPENAI_PROVIDER_NAME ?? "openai-chat-completions",
    apiKey: options.apiKey ?? process.env.OPENAI_API_KEY,
    baseURL: options.baseURL ?? process.env.OPENAI_BASE_URL,
    organization: options.organization ?? process.env.OPENAI_ORG_ID,
    project: options.project ?? process.env.OPENAI_PROJECT_ID,
    defaultHeaders:
      cloneHeaders(options.defaultHeaders) ??
      parseOptionalHeaders(process.env.OPENAI_DEFAULT_HEADERS_JSON),
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
      (process.env
        .OPENAI_REASONING_EFFORT as OpenAICompatibleChatProviderOptions["defaultReasoningEffort"]),
  };
}

export function createClientOptions(
  options: ResolvedOpenAICompatibleChatProviderOptions,
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
      globalThis.fetch.bind(globalThis),
    );
  }

  return clientOptions;
}
