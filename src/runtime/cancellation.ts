import { combineAbortSignals } from "../shared/abort.js";
import type { AIChatRequest, AIProvider } from "../types.js";

function withWorkflowAbortSignal(
  request: AIChatRequest,
  workflowSignal: AbortSignal,
): AIChatRequest {
  const signal = combineAbortSignals([workflowSignal, request.http?.signal]);
  if (!signal) {
    return request;
  }

  return {
    ...request,
    http: {
      ...request.http,
      signal,
    },
  };
}

export function createAbortAwareAIProvider(
  provider: AIProvider,
  workflowSignal: AbortSignal,
): AIProvider {
  return {
    provider: provider.provider,
    ...(provider.apiType ? { apiType: provider.apiType } : {}),
    defaultChatModel: provider.defaultChatModel,
    chat: (request) =>
      provider.chat(withWorkflowAbortSignal(request, workflowSignal)),
    chatStream: (request) =>
      provider.chatStream(withWorkflowAbortSignal(request, workflowSignal)),
  };
}
