import type {
  AIChatRequest,
  AIChatResponse,
  AIChatStream,
  AIProvider
} from "./types.js";

class UnconfiguredAIProvider implements AIProvider {
  readonly provider = "unconfigured";

  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const requestedModel = request.model ? ` Requested model=${request.model}.` : "";
    throw new Error(
      `No AI provider configured for this workflow run.${requestedModel} Pass \`aiProvider\` to \`createCycle()\` or use \`createOpenAICompatibleChatProvider()\`.`
    );
  }

  async chatStream(request: AIChatRequest): Promise<AIChatStream> {
    const requestedModel = request.model ? ` Requested model=${request.model}.` : "";
    throw new Error(
      `No AI provider configured for this workflow run.${requestedModel} Pass \`aiProvider\` to \`createCycle()\` or use \`createOpenAICompatibleChatProvider()\`.`
    );
  }
}

export function createUnavailableAIProvider(): AIProvider {
  return new UnconfiguredAIProvider();
}
