import type {
  AIChatRequest,
  AIChatResponse,
  AIChatStream,
  AIProvider
} from "../../../dist/index.js";

function createResponse(request: AIChatRequest): AIChatResponse {
  const text = request.messages
    .map((message: AIChatRequest["messages"][number]) => `${message.role}:${message.content}`)
    .join("\n");

  return {
    provider: "repro-provider",
    model: "repro-model",
    outputText: `echo:${text.slice(0, 80)}`,
    message: {
      role: "assistant",
      content: `echo:${text.slice(0, 80)}`
    },
    usage: {
      inputTokens: Math.max(1, Math.ceil(text.length / 4)),
      outputTokens: 8,
      totalTokens: Math.max(1, Math.ceil(text.length / 4)) + 8
    },
    finishReason: "stop"
  };
}

export function createFakeAIProvider(): AIProvider {
  return {
    provider: "repro-provider",
    defaultChatModel: "repro-model",
    async chat(request: AIChatRequest): Promise<AIChatResponse> {
      return createResponse(request);
    },
    async chatStream(request: AIChatRequest): Promise<AIChatStream> {
      const response = createResponse(request);

      async function* stream() {
        yield {
          provider: response.provider,
          model: response.model,
          deltaText: response.outputText,
          outputText: response.outputText,
          raw: {
            done: true
          }
        };
      }

      const iterator = stream();
      return {
        [Symbol.asyncIterator]() {
          return iterator;
        },
        finalResponse: Promise.resolve(response)
      };
    }
  };
}
