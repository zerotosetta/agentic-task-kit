import type {
  AIChatRequest,
  AIChatResponse,
  AIProvider
} from "./types.js";

class UnconfiguredAIProvider implements AIProvider {
  readonly provider = "unconfigured";

  async chat(request: AIChatRequest): Promise<AIChatResponse> {
    const requestedModel = request.model ? ` Requested model=${request.model}.` : "";
    throw new Error(
      `No AI provider configured for this workflow run.${requestedModel} Pass \`aiProvider\` to \`createCycle()\` or use \`createOpenAIChatProvider()\`.`
    );
  }
}

export function createUnavailableAIProvider(): AIProvider {
  return new UnconfiguredAIProvider();
}
