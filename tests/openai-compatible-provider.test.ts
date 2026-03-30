import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import {
  AIProviderRequestError,
  createOpenAICompatibleChatProvider
} from "../src/index.js";

type CapturedRequest = {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown> | null;
};

async function readJsonBody(req: AsyncIterable<Buffer | string>): Promise<Record<string, unknown> | null> {
  let body = "";

  for await (const chunk of req) {
    body += chunk.toString();
  }

  if (!body) {
    return null;
  }

  return JSON.parse(body) as Record<string, unknown>;
}

async function createMockServer(): Promise<{
  server: Server;
  baseURL: string;
  requests: CapturedRequest[];
}> {
  const requests: CapturedRequest[] = [];
  const server = createServer(async (req, res) => {
    const body = await readJsonBody(req);
    requests.push({
      url: req.url ?? "",
      headers: req.headers,
      body
    });

    if (req.url !== "/v1/chat/completions") {
      res.writeHead(404);
      res.end();
      return;
    }

    const model = typeof body?.model === "string" ? body.model : "unknown-model";
    const isStream = body?.stream === true;

    if (model === "missing-model") {
      res.writeHead(404, {
        "content-type": "application/json",
        "x-request-id": "req-missing-model"
      });
      res.end(
        JSON.stringify({
          error: {
            message: "Model missing-model was not found.",
            type: "invalid_request_error",
            code: "model_not_found",
            param: "model"
          }
        })
      );
      return;
    }

    if (!isStream) {
      res.writeHead(200, {
        "content-type": "application/json"
      });
      res.end(
        JSON.stringify({
          id: "chatcmpl-compatible",
          object: "chat.completion",
          created: 1,
          model,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: "Hello from compatible server."
              }
            }
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 4,
            total_tokens: 14,
            completion_tokens_details: {
              reasoning_tokens: 1
            }
          }
        })
      );
      return;
    }

    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive"
    });
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: "assistant",
              content: "Hello "
            },
            finish_reason: null
          }
        ]
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            delta: {
              content: "streamed world."
            },
            finish_reason: null
          }
        ]
      })}\n\n`
    );
    res.write(
      `data: ${JSON.stringify({
        id: "chatcmpl-stream",
        object: "chat.completion.chunk",
        created: 1,
        model,
        choices: [
          {
            index: 0,
            delta: {},
            finish_reason: "stop"
          }
        ],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12
        }
      })}\n\n`
    );
    res.end("data: [DONE]\n\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to resolve mock server address.");
  }

  return {
    server,
    baseURL: `http://127.0.0.1:${address.port}/v1`,
    requests
  };
}

describe("OpenAI-compatible provider", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => {
              if (error) {
                reject(error);
                return;
              }

              resolve();
            });
          })
      )
    );
  });

  it("supports OpenAI-compatible baseURL and custom headers for chat", async () => {
    const mock = await createMockServer();
    servers.push(mock.server);

    const provider = createOpenAICompatibleChatProvider({
      providerName: "mock-compatible",
      apiKey: "test-key",
      baseURL: mock.baseURL,
      defaultModel: "compatible-model",
      defaultHeaders: {
        "X-Cycle-App": "agentic-task-kit",
        "HTTP-Referer": "https://example.test/cycle"
      }
    });

    const response = await provider.chat({
      messages: [
        {
          role: "developer",
          content: "Reply briefly."
        },
        {
          role: "user",
          content: "Say hello."
        }
      ],
      promptCacheKey: "compat-1",
      http: {
        headers: {
          "X-Request-ID": "req-123"
        }
      }
    });

    expect(response.provider).toBe("mock-compatible");
    expect(response.model).toBe("compatible-model");
    expect(response.outputText).toBe("Hello from compatible server.");
    expect(response.usage?.totalTokens).toBe(14);

    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.url).toBe("/v1/chat/completions");
    expect(mock.requests[0]?.headers.authorization).toBe("Bearer test-key");
    expect(mock.requests[0]?.headers["x-cycle-app"]).toBe("agentic-task-kit");
    expect(mock.requests[0]?.headers["http-referer"]).toBe("https://example.test/cycle");
    expect(mock.requests[0]?.headers["x-request-id"]).toBe("req-123");
    expect(mock.requests[0]?.body?.model).toBe("compatible-model");
    expect(mock.requests[0]?.body?.prompt_cache_key).toBe("compat-1");
  });

  it("supports streaming responses and request-scoped headers", async () => {
    const mock = await createMockServer();
    servers.push(mock.server);

    const provider = createOpenAICompatibleChatProvider({
      providerName: "mock-compatible-stream",
      apiKey: "test-key",
      baseURL: mock.baseURL,
      defaultModel: "stream-model"
    });

    const stream = await provider.chatStream({
      messages: [
        {
          role: "developer",
          content: "Stream your answer."
        },
        {
          role: "user",
          content: "Say hello in a streamed way."
        }
      ],
      http: {
        headers: {
          "X-Stream-Request": "yes"
        }
      }
    });

    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const finalResponse = await stream.finalResponse;

    expect(chunks.map((chunk) => chunk.deltaText).join("")).toBe("Hello streamed world.");
    expect(chunks.at(-1)?.finishReason).toBe("stop");
    expect(finalResponse.provider).toBe("mock-compatible-stream");
    expect(finalResponse.model).toBe("stream-model");
    expect(finalResponse.outputText).toBe("Hello streamed world.");
    expect(finalResponse.finishReason).toBe("stop");
    expect(finalResponse.usage?.totalTokens).toBe(12);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]?.body?.stream).toBe(true);
    expect(mock.requests[0]?.headers["x-stream-request"]).toBe("yes");
  });

  it("prints redacted HTTP debug logs when enabled", async () => {
    const mock = await createMockServer();
    servers.push(mock.server);

    const debugStream = new PassThrough();
    let output = "";
    debugStream.on("data", (chunk) => {
      output += chunk.toString();
    });

    const provider = createOpenAICompatibleChatProvider({
      providerName: "mock-compatible-debug",
      apiKey: "test-key",
      baseURL: mock.baseURL,
      defaultModel: "debug-model",
      httpDebugLogging: {
        stream: debugStream as unknown as NodeJS.WriteStream,
        includeHeaders: true,
        includeResponseHeaders: true,
        includeRequestBody: true
      }
    });

    await provider.chat({
      messages: [
        {
          role: "user",
          content: "Debug this request."
        }
      ]
    });

    expect(output).toContain('"phase":"request"');
    expect(output).toContain('"phase":"response"');
    expect(output).toContain('"provider":"mock-compatible-debug"');
    expect(output).toContain('"authorization":"[REDACTED]"');
    expect(output).toContain('"status":200');
    expect(output).toContain('"model":"debug-model"');
  });

  it("surfaces status code, response body, and original error for chat failures", async () => {
    const mock = await createMockServer();
    servers.push(mock.server);

    const provider = createOpenAICompatibleChatProvider({
      providerName: "mock-compatible-error",
      apiKey: "test-key",
      baseURL: mock.baseURL,
      defaultModel: "missing-model"
    });

    let thrown: unknown;
    try {
      await provider.chat({
        messages: [
          {
            role: "user",
            content: "Trigger a not found error."
          }
        ]
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AIProviderRequestError);
    const providerError = thrown as AIProviderRequestError;
    expect(providerError.status).toBe(404);
    expect(providerError.code).toBe("model_not_found");
    expect(providerError.type).toBe("invalid_request_error");
    expect(providerError.param).toBe("model");
    expect(providerError.requestId).toBe("req-missing-model");
    expect(providerError.responseBody).toEqual({
      message: "Model missing-model was not found.",
      type: "invalid_request_error",
      code: "model_not_found",
      param: "model"
    });
    expect(providerError.originalError).toBeInstanceOf(Error);
    expect(providerError.message).toContain("status=404");
    expect(providerError.message).toContain("response=");
  });

  it("surfaces enriched errors for streaming failures", async () => {
    const mock = await createMockServer();
    servers.push(mock.server);

    const provider = createOpenAICompatibleChatProvider({
      providerName: "mock-compatible-stream-error",
      apiKey: "test-key",
      baseURL: mock.baseURL,
      defaultModel: "missing-model"
    });

    const stream = await provider.chatStream({
      messages: [
        {
          role: "user",
          content: "Trigger a streamed not found error."
        }
      ]
    });

    await expect(stream.finalResponse).rejects.toBeInstanceOf(AIProviderRequestError);
    await expect(
      (async () => {
        for await (const _chunk of stream) {
          // no-op
        }
      })()
    ).rejects.toMatchObject({
      status: 404,
      code: "model_not_found"
    });
  });
});
