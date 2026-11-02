export type AIChatMessageRole = "developer" | "system" | "user" | "assistant";

export type AITextContentPart = {
  type: "text" | "input_text";
  text: string;
};

export type AIImageURLContentPart = {
  type: "image_url";
  imageUrl?: string;
  image_url?: string | { url: string; detail?: "auto" | "low" | "high" };
  detail?: "auto" | "low" | "high";
};

export type AIChatContentPart = AITextContentPart | AIImageURLContentPart;

export type AIChatMessageContent = string | AIChatContentPart[];

export type AISessionMessage = {
  role: AIChatMessageRole;
  content: AIChatMessageContent;
  name?: string;
};

export type AISession = {
  sessionId: string;
  llmModelId: string;
  embeddingModelId: string;
  messages: AISessionMessage[];
  fork: (opts?: { label?: string }) => AISession;
};

export type AIReasoningEffort =
  "none" | "minimal" | "low" | "medium" | "high" | "xhigh";

export type AIHTTPHeaders = Record<string, string>;

export type AIHTTPRequestOptions = {
  baseURL?: string;
  headers?: AIHTTPHeaders;
  timeoutMs?: number;
  maxRetries?: number;
  signal?: AbortSignal;
};

export type AIHTTPDebugLoggingOptions = {
  enabled?: boolean;
  stream?: NodeJS.WritableStream;
  includeHeaders?: boolean;
  includeResponseHeaders?: boolean;
  includeRequestBody?: boolean;
  redactHeaders?: string[];
};

export type AIChatRequest = {
  model?: string;
  messages?: AISessionMessage[];
  /** Native API fields, forwarded without a field allowlist. */
  payload?: Record<string, unknown>;
  /** Replace skips common-message conversion and provider defaultPayload. */
  payloadMode?: "merge" | "replace";
  temperature?: number;
  maxCompletionTokens?: number;
  reasoningEffort?: AIReasoningEffort;
  metadata?: Record<string, string>;
  promptCacheKey?: string;
  http?: AIHTTPRequestOptions;
};

export type AIChatUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
};

export type AIProviderRequestErrorDetails = {
  provider: string;
  model?: string;
  status?: number;
  requestId?: string | null;
  code?: string | null;
  type?: string;
  param?: string | null;
  responseBody?: unknown;
  originalError: unknown;
};

export type AIChatResponse = {
  provider: string;
  model: string;
  outputText: string;
  message: AISessionMessage;
  finishReason?: string | null;
  usage?: AIChatUsage;
  raw?: unknown;
};

export type AIChatStreamChunk = {
  provider: string;
  model: string;
  deltaText: string;
  outputText: string;
  finishReason?: string | null;
  usage?: AIChatUsage;
  raw?: unknown;
};

export interface AIChatStream extends AsyncIterable<AIChatStreamChunk> {
  finalResponse: Promise<AIChatResponse>;
}

export interface AIProvider {
  provider: string;
  apiType?: AIAPIType;
  defaultChatModel?: string | undefined;
  chat(request: AIChatRequest): Promise<AIChatResponse>;
  chatStream(request: AIChatRequest): Promise<AIChatStream>;
}

export type OpenAICompatibleChatProviderOptions = {
  apiType?: AIAPIType;
  providerName?: string;
  apiKey?: string;
  baseURL?: string;
  organization?: string;
  project?: string;
  defaultHeaders?: AIHTTPHeaders;
  httpDebugLogging?: boolean | AIHTTPDebugLoggingOptions;
  defaultModel?: string;
  defaultPayload?: Record<string, unknown>;
  timeoutMs?: number;
  maxRetries?: number;
  defaultTemperature?: number;
  defaultMaxCompletionTokens?: number;
  defaultReasoningEffort?: AIReasoningEffort;
};

export type AIAPIType =
  | "openai-chat-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "gemini-generate-content";

export type AIProviderOptions = OpenAICompatibleChatProviderOptions;
export type AIProviderFileConfig = OpenAICompatibleChatProviderFileConfig;
export type AIProviderConfigFileOptions =
  OpenAICompatibleChatProviderConfigFileOptions;

export type OpenAICompatibleChatProviderFileConfig =
  OpenAICompatibleChatProviderOptions & {
    apiKeyEnv?: string;
    baseURLEnv?: string;
    organizationEnv?: string;
    projectEnv?: string;
  };

export type OpenAICompatibleChatProviderConfigFileOptions = {
  configPath?: string;
  overrides?: OpenAICompatibleChatProviderOptions;
};

export type OpenAIChatProviderOptions = OpenAICompatibleChatProviderOptions;

export type OpenAIChatProviderFileConfig =
  OpenAICompatibleChatProviderFileConfig;

export type OpenAIChatProviderConfigFileOptions =
  OpenAICompatibleChatProviderConfigFileOptions;
