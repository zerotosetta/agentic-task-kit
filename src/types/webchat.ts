import type {
  AIChatRequest,
  AIChatUsage,
  AIHTTPRequestOptions,
  AIProvider,
  AIProviderOptions,
} from "./ai.js";

export type WebChatValuePath = readonly (string | number)[];
export type WebChatEndpoint = {
  path: string;
  method?: "GET" | "POST";
  /** Supports {sessionId}, {messageId}, {model}, and {assistantUUID}. */
  payload?: Record<string, unknown>;
  templatePayload?: boolean;
};
export type WebChatSession = { sessionId: string; model: string; raw: unknown };
export type WebChatAssistantResult = {
  text: string;
  finishReason?: string;
  usage?: AIChatUsage;
};
export type WebChatCompletionContext = {
  session: WebChatSession;
  request: AIChatRequest;
  lastMessage: Record<string, unknown>;
  messageId?: string | number;
  postedResponses: readonly unknown[];
  signal: AbortSignal;
  send(endpoint: WebChatEndpoint): Promise<unknown>;
};
export type WebChatCompletion =
  | { mode: "append" }
  | ({ mode: "request" } & WebChatEndpoint)
  | ({
      mode: "poll";
      trigger?: WebChatEndpoint;
      intervalMs?: number;
      maxAttempts?: number;
    } & WebChatEndpoint)
  | {
      mode: "custom";
      complete(context: WebChatCompletionContext): Promise<unknown>;
    };
export type WebChatProviderSettings = {
  assistantUUID?: string;
  title?: string;
  sessionId?: string;
  sessionPayload?: Record<string, unknown>;
  maxSessionCount?: number;
  apiKeyHeader?: string;
  createSessionPath?: string;
  appendMessagePath?: string;
  sessionIdPath?: WebChatValuePath;
  responsePath?: WebChatValuePath;
  readyWhen?: {
    path: WebChatValuePath;
    equals: string | number | boolean | null;
  };
  completion?: WebChatCompletion;
  extractAssistant?(
    raw: unknown,
    context: WebChatCompletionContext,
  ): WebChatAssistantResult | undefined;
};
export type WebChatRequestOptions = {
  sessionId?: string;
  title?: string;
  assistantUUID?: string;
  sessionPayload?: Record<string, unknown>;
};
export type WebChatAIProviderOptions = Omit<AIProviderOptions, "apiType"> & {
  apiType?: "webchat";
};
export interface WebChatAIProvider extends AIProvider {
  apiType: "webchat";
  createSession(request?: AIChatRequest): Promise<WebChatSession>;
  appendMessage(
    sessionId: string,
    message: Record<string, unknown>,
    http?: AIHTTPRequestOptions,
  ): Promise<unknown>;
}
