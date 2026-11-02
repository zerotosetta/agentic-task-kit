import {
  createServer,
  type IncomingHttpHeaders,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  AIProviderRequestError,
  Task,
  createAIProvider,
  createAIProviderFromConfigFile,
  createCycle,
  createWorkflowInput,
  type AIAPIType,
  type TaskLogEvent,
  type WorkflowContext,
} from "../src/index.js";

const apiTypes: Exclude<AIAPIType, "webchat">[] = [
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
  "gemini-generate-content",
];
const nativeTypes = apiTypes.slice(1);
type Captured = {
  url: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
};
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function mock(
  handler: (request: Captured, response: ServerResponse, count: number) => void,
) {
  const requests: Captured[] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const captured = {
      url: request.url ?? "",
      headers: request.headers,
      body: JSON.parse(body) as Record<string, unknown>,
    };
    requests.push(captured);
    handler(captured, response, requests.length);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return {
    requests,
    baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`,
  };
}
function responseBody(apiType: AIAPIType) {
  const usage = { input_tokens: 5, output_tokens: 7, total_tokens: 12 };
  if (apiType === "openai-chat-completions")
    return {
      model: "custom-model",
      choices: [{ message: { content: "안녕" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
    };
  if (apiType === "openai-responses")
    return {
      model: "custom-model",
      status: "completed",
      output: [
        { type: "message", content: [{ type: "output_text", text: "안녕" }] },
      ],
      usage,
    };
  if (apiType === "anthropic-messages")
    return {
      model: "custom-model",
      content: [{ type: "text", text: "안녕" }],
      stop_reason: "end_turn",
      usage,
    };
  return {
    modelVersion: "custom-model",
    candidates: [
      {
        content: {
          parts: [{ text: "private", thought: true }, { text: "안녕" }],
        },
        finishReason: "STOP",
      },
    ],
    usageMetadata: {
      promptTokenCount: 5,
      candidatesTokenCount: 7,
      totalTokenCount: 12,
    },
  };
}
function nativeInput(apiType: AIAPIType): Record<string, unknown> {
  if (apiType === "openai-responses")
    return {
      model: "custom-model",
      input: [
        { type: "function_call_output", call_id: "call-1", output: "ok" },
      ],
    };
  if (apiType === "gemini-generate-content")
    return {
      contents: [
        {
          role: "user",
          parts: [{ inlineData: { mimeType: "audio/wav", data: "AAAA" } }],
        },
      ],
    };
  return {
    model: "custom-model",
    messages: [
      { role: "user", content: [{ type: "text", text: "native request" }] },
    ],
  };
}
function events(apiType: AIAPIType): unknown[] {
  if (apiType === "openai-chat-completions")
    return [
      { model: "custom-model", choices: [{ delta: { content: "안" } }] },
      {
        model: "custom-model",
        choices: [
          {
            delta: { content: "녕", tool_calls: [{ index: 0, id: "call-1" }] },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
      },
    ];
  if (apiType === "openai-responses")
    return [
      { type: "response.created", response: { model: "custom-model" } },
      { type: "response.output_text.delta", delta: "안" },
      {
        type: "response.function_call_arguments.delta",
        delta: '{"tool":true}',
      },
      { type: "response.output_text.delta", delta: "녕" },
      { type: "response.completed", response: responseBody(apiType) },
    ];
  if (apiType === "anthropic-messages")
    return [
      {
        type: "message_start",
        message: {
          model: "custom-model",
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
      {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "private" },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "안" },
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "녕" },
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      },
      { type: "message_stop" },
    ];
  return [
    {
      modelVersion: "custom-model",
      candidates: [
        {
          content: {
            parts: [
              { text: "private", thought: true },
              { text: "안" },
              { functionCall: { name: "lookup", args: {} } },
            ],
          },
        },
      ],
      usageMetadata: { promptTokenCount: 5 },
    },
    {
      candidates: [
        { content: { parts: [{ text: "녕" }] }, finishReason: "STOP" },
      ],
      usageMetadata: { candidatesTokenCount: 7, totalTokenCount: 12 },
    },
  ];
}
function sendJSON(response: ServerResponse, body: unknown) {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
function frame(value: unknown) {
  return `event: ${String((value as { type?: string }).type ?? "message")}\r\ndata: ${JSON.stringify(value)}\r\n\r\n`;
}

describe.each(apiTypes)("%s native payload", (apiType) => {
  it("forwards model-specific fields and accepts payload without common messages", async () => {
    const server = await mock((_request, response) =>
      sendJSON(response, responseBody(apiType)),
    );
    const payload = {
      ...nativeInput(apiType),
      tools: [
        { type: "custom", schema: { arbitrary: [1, null, { nested: true }] } },
      ],
      vendor_extension: { future_option: true },
    };
    const provider = createAIProvider({
      apiType,
      apiKey: "local-secret",
      defaultModel: "custom-model",
      baseURL: server.baseURL,
      maxRetries: 0,
      defaultPayload: { provider_default: true },
    });
    const result = await provider.chat({ payload });
    expect(result.outputText).toBe("안녕");
    expect(result.usage).toMatchObject({ inputTokens: 5, outputTokens: 7 });
    expect(result.raw).toEqual(responseBody(apiType));
    expect(server.requests[0]?.body).toMatchObject({
      ...payload,
      provider_default: true,
    });
    expect(payload).not.toHaveProperty("provider_default");
    const paths = {
      "openai-chat-completions": "/api/chat/completions",
      "openai-responses": "/api/responses",
      "anthropic-messages": "/api/messages",
      "gemini-generate-content": "/api/models/custom-model:generateContent",
    };
    expect(server.requests[0]?.url).toBe(paths[apiType]);
    const headers = server.requests[0]!.headers;
    if (apiType === "anthropic-messages") {
      expect(headers["x-api-key"]).toBe("local-secret");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers.authorization).toBeUndefined();
    } else if (apiType === "gemini-generate-content")
      expect(headers["x-goog-api-key"]).toBe("local-secret");
    else expect(headers.authorization).toBe("Bearer local-secret");
  });

  it("replaces defaults and skips generic message conversion without mutating input", async () => {
    const server = await mock((_request, response) =>
      sendJSON(response, responseBody(apiType)),
    );
    const payload = {
      ...nativeInput(apiType),
      ...(apiType !== "gemini-generate-content" ? { stream: true } : {}),
    };
    const provider = createAIProvider({
      apiType,
      apiKey: "local",
      defaultModel: "custom-model",
      baseURL: server.baseURL,
      defaultTemperature: 0.8,
      defaultPayload: { unwanted: true, temperature: 0.5 },
    });
    await provider.chat({
      payload,
      payloadMode: "replace",
      messages: [
        {
          role: "system",
          content: [{ type: "image_url", imageUrl: "invalid-for-system" }],
        },
      ],
    });
    expect(server.requests[0]?.body).toEqual({
      ...payload,
      ...(apiType !== "gemini-generate-content" ? { stream: false } : {}),
    });
    if (apiType !== "gemini-generate-content")
      expect(payload.stream).toBe(true);
  });

  it("streams text and usage while preserving tool/thinking/vendor events in raw", async () => {
    const source = events(apiType);
    const server = await mock((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const bytes = Buffer.from(
        ":heartbeat\r\n\r\n" +
          source.map(frame).join("") +
          (apiType === "openai-chat-completions" ? "data: [DONE]\r\n\r\n" : ""),
      );
      // Deliberately split UTF-8 and CRLF boundaries.
      for (let offset = 0; offset < bytes.length; offset += 7)
        response.write(bytes.subarray(offset, offset + 7));
      response.end();
    });
    const provider = createAIProvider({
      apiType,
      apiKey: "local",
      defaultModel: "custom-model",
      baseURL: server.baseURL,
    });
    const stream = await provider.chatStream({
      payload: {
        ...nativeInput(apiType),
        stream: false,
        vendor_extension: true,
      },
    });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const result = await stream.finalResponse;
    expect(chunks.map((chunk) => chunk.deltaText).join("")).toBe("안녕");
    expect(result.outputText).toBe("안녕");
    expect(result.usage).toMatchObject({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
    });
    expect(chunks.map((chunk) => chunk.raw)).toMatchObject(source);
    expect(server.requests[0]?.body.vendor_extension).toBe(true);
    if (apiType !== "gemini-generate-content")
      expect(server.requests[0]?.body.stream).toBe(true);
    else
      expect(server.requests[0]?.url).toContain(
        ":streamGenerateContent?alt=sse",
      );
  });
});

describe("Native protocol mapping and lifecycle", () => {
  it.each(nativeTypes)(
    "maps common text/images/system settings for %s",
    async (apiType) => {
      const server = await mock((_request, response) =>
        sendJSON(response, responseBody(apiType)),
      );
      await createAIProvider({
        apiType,
        apiKey: "local",
        defaultModel: "custom-model",
        baseURL: server.baseURL,
      }).chat({
        messages: [
          { role: "developer", content: "policy" },
          {
            role: "user",
            content: [
              { type: "input_text", text: "describe" },
              { type: "image_url", imageUrl: "data:image/png;base64,AAAA" },
            ],
          },
        ],
        maxCompletionTokens: 55,
        temperature: 0.3,
        reasoningEffort: "high",
      });
      const body = server.requests[0]!.body;
      if (apiType === "openai-responses")
        expect(body).toMatchObject({
          max_output_tokens: 55,
          reasoning: { effort: "high" },
          input: [
            { role: "developer", content: "policy" },
            {
              role: "user",
              content: [
                { type: "input_text", text: "describe" },
                {
                  type: "input_image",
                  image_url: "data:image/png;base64,AAAA",
                },
              ],
            },
          ],
        });
      else if (apiType === "anthropic-messages")
        expect(body).toMatchObject({
          max_tokens: 55,
          system: "policy",
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "describe" },
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: "image/png",
                    data: "AAAA",
                  },
                },
              ],
            },
          ],
        });
      else
        expect(body).toMatchObject({
          systemInstruction: { parts: [{ text: "policy" }] },
          generationConfig: { maxOutputTokens: 55, temperature: 0.3 },
          contents: [
            {
              role: "user",
              parts: [
                { text: "describe" },
                { inlineData: { mimeType: "image/png", data: "AAAA" } },
              ],
            },
          ],
        });
    },
  );

  it("uses shallow precedence and preserves model-native tool conversation roles", async () => {
    const server = await mock((_request, response) =>
      sendJSON(response, responseBody("openai-chat-completions")),
    );
    const provider = createAIProvider({
      apiKey: "local",
      defaultModel: "default-model",
      baseURL: server.baseURL,
      defaultPayload: {
        messages: [{ role: "tool", tool_call_id: "call-1", content: "result" }],
        temperature: 0.1,
        response_format: { type: "text" },
      },
      defaultTemperature: 0.2,
    });
    await provider.chat({
      temperature: 0.3,
      payload: {
        model: "custom-model",
        temperature: 0.4,
        response_format: { type: "json_object" },
        max_tokens: 13,
      },
    });
    expect(server.requests[0]?.body).toMatchObject({
      model: "custom-model",
      temperature: 0.4,
      max_tokens: 13,
      response_format: { type: "json_object" },
      messages: [{ role: "tool", tool_call_id: "call-1", content: "result" }],
    });
  });

  it.each(nativeTypes)(
    "rejects premature EOF instead of succeeding with partial %s output",
    async (apiType) => {
      const server = await mock((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(events(apiType).slice(0, -1).map(frame).join(""));
      });
      const stream = await createAIProvider({
        apiType,
        apiKey: "local",
        defaultModel: "custom-model",
        baseURL: server.baseURL,
      }).chatStream({ payload: nativeInput(apiType) });
      await expect(async () => {
        for await (const _chunk of stream) {
          /* Drain stream. */
        }
      }).rejects.toThrow("terminal event");
      await expect(stream.finalResponse).rejects.toBeInstanceOf(
        AIProviderRequestError,
      );
    },
  );

  it.each(nativeTypes)(
    "surfaces HTTP-200 stream errors from %s",
    async (apiType) => {
      const server = await mock((_request, response) => {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          frame({
            type: "error",
            error: {
              type: "overloaded_error",
              message: "native stream failed",
            },
          }),
        );
      });
      const stream = await createAIProvider({
        apiType,
        apiKey: "local",
        defaultModel: "custom-model",
        baseURL: server.baseURL,
      }).chatStream({ payload: nativeInput(apiType) });
      await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(
        "native stream failed",
      );
      await expect(stream.finalResponse).rejects.toMatchObject({
        type: "overloaded_error",
      });
    },
  );

  it("cancels the native HTTP stream when its consumer returns early", async () => {
    let disconnected = false;
    const server = await mock((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = () =>
        response.write(
          frame({ type: "response.output_text.delta", delta: "chunk" }),
        );
      send();
      const timer = setInterval(send, 20);
      response.on("close", () => {
        clearInterval(timer);
        disconnected = true;
      });
    });
    const stream = await createAIProvider({
      apiType: "openai-responses",
      defaultModel: "custom-model",
      baseURL: server.baseURL,
    }).chatStream({ payload: { input: "stream" } });
    for await (const chunk of stream) {
      expect(chunk.deltaText).toBe("chunk");
      break;
    }
    await expect(stream.finalResponse).rejects.toBeInstanceOf(
      AIProviderRequestError,
    );
    await expect.poll(() => disconnected).toBe(true);
  });

  it("retries transient HTTP failures but preserves non-retryable status/body/request id", async () => {
    const server = await mock((_request, response, count) => {
      if (count === 2) {
        sendJSON(response, responseBody("openai-responses"));
        return;
      }
      response.writeHead(count === 1 ? 503 : 400, {
        "content-type": "application/json",
        "x-request-id": "native-request-id",
      });
      response.end(
        JSON.stringify({
          error: { code: "native_code", message: "native failure" },
        }),
      );
    });
    const provider = createAIProvider({
      apiType: "openai-responses",
      defaultModel: "custom-model",
      baseURL: server.baseURL,
      maxRetries: 2,
    });
    expect(
      (await provider.chat({ payload: { input: "retry" } })).outputText,
    ).toBe("안녕");
    await expect(
      provider.chat({ payload: { input: "invalid" } }),
    ).rejects.toMatchObject({
      status: 400,
      requestId: "native-request-id",
      code: "native_code",
      responseBody: { error: { message: "native failure" } },
    });
    expect(server.requests).toHaveLength(3);
  });

  it("honors native timeout and externally supplied abort signals", async () => {
    const server = await mock(() => {
      /* Wait for client cancellation. */
    });
    const provider = createAIProvider({
      apiType: "openai-responses",
      defaultModel: "custom-model",
      baseURL: server.baseURL,
      maxRetries: 0,
    });
    await expect(
      provider.chat({ payload: { input: "timeout" }, http: { timeoutMs: 20 } }),
    ).rejects.toBeInstanceOf(AIProviderRequestError);
    const controller = new AbortController();
    controller.abort(new Error("cancelled by caller"));
    await expect(
      provider.chat({
        payload: { input: "abort" },
        http: { signal: controller.signal },
      }),
    ).rejects.toThrow("cancelled by caller");
  });

  it("uses vendor authentication and redacts Gemini keys from debug logs", async () => {
    const log = new PassThrough();
    let output = "";
    log.on("data", (chunk) => (output += String(chunk)));
    const server = await mock((_request, response) =>
      sendJSON(response, responseBody("gemini-generate-content")),
    );
    await createAIProvider({
      apiType: "gemini-generate-content",
      apiKey: "gemini-secret-key",
      defaultModel: "custom-model",
      baseURL: server.baseURL,
      defaultHeaders: { "X-Custom": "default" },
      httpDebugLogging: { stream: log },
    }).chat({
      payload: nativeInput("gemini-generate-content"),
      http: { headers: { "x-custom": "request" } },
    });
    expect(server.requests[0]?.headers["x-goog-api-key"]).toBe(
      "gemini-secret-key",
    );
    expect(server.requests[0]?.headers["x-custom"]).toBe("request");
    expect(server.requests[0]?.url).not.toContain("secret");
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("gemini-secret-key");
  });

  it("loads API type/native defaults from a JSON config and supports workflow monitoring without messages", async () => {
    const server = await mock((_request, response) =>
      sendJSON(response, responseBody("openai-responses")),
    );
    const temporary = await mkdtemp(join(tmpdir(), "cycle native payload "));
    cleanup.push(() => rm(temporary, { recursive: true, force: true }));
    const configPath = join(temporary, "provider.json");
    await writeFile(
      configPath,
      JSON.stringify({
        apiType: "openai-responses",
        baseURL: server.baseURL,
        defaultModel: "custom-model",
        defaultPayload: {
          input: "from config",
          tools: [{ type: "custom-tool" }],
        },
      }),
    );
    const provider = createAIProviderFromConfigFile({ configPath });
    const logs: TaskLogEvent[] = [];
    class NativeTask extends Task {
      name = "native";
      memoryPhase = "EXECUTION" as const;
      memoryTaskType = "workflow" as const;
      async run(ctx: WorkflowContext) {
        const response = await ctx.ai.chat({ payload: { input: "from task" } });
        return { status: "success" as const, output: response.outputText };
      }
    }
    const cycle = createCycle({
      aiProvider: provider,
      observers: [
        {
          onEvent() {},
          onTaskLog(event) {
            logs.push(event);
          },
        },
      ],
    });
    cycle.register("native", {
      name: "native",
      start: "native",
      tasks: { native: new NativeTask() },
      transitions: { native: "end" },
    });
    const result = await cycle.run("native", createWorkflowInput({}));
    expect(result.frame.status).toBe("success");
    expect(server.requests[0]?.body).toMatchObject({
      input: "from task",
      tools: [{ type: "custom-tool" }],
    });
    expect(
      logs.find((log) => log.message === "AI chat request")?.meta,
    ).toMatchObject({ apiType: "openai-responses", messageCount: 0 });
  });

  it("rejects unknown protocol names instead of silently selecting a different API", () => {
    expect(() =>
      createAIProvider({ apiType: "unsupported" as AIAPIType }),
    ).toThrow("Unsupported AI apiType");
  });

  it.each(nativeTypes)(
    "preserves tool-only %s responses without requiring assistant text",
    async (apiType) => {
      const tool = { name: "lookup", arguments: { id: 42 } };
      const raw =
        apiType === "openai-responses"
          ? {
              status: "completed",
              output: [{ type: "function_call", ...tool }],
            }
          : apiType === "anthropic-messages"
            ? {
                content: [{ type: "tool_use", ...tool }],
                stop_reason: "tool_use",
              }
            : {
                candidates: [
                  {
                    content: { parts: [{ functionCall: tool }] },
                    finishReason: "STOP",
                  },
                ],
              };
      const server = await mock((_request, response) =>
        sendJSON(response, raw),
      );
      const result = await createAIProvider({
        apiType,
        defaultModel: "custom-model",
        baseURL: server.baseURL,
      }).chat({ payload: nativeInput(apiType) });
      expect(result.outputText).toBe("");
      expect(result.raw).toEqual(raw);
    },
  );

  it("handles CR-only and multiline SSE data, including event-name-only dispatch", async () => {
    const server = await mock((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'event: response.output_text.delta\rdata: {\rdata: "delta": "안녕"\rdata: }\r\r',
      );
      response.end(
        frame({
          type: "response.completed",
          response: responseBody("openai-responses"),
        }).replaceAll("\r\n", "\r"),
      );
    });
    const stream = await createAIProvider({
      apiType: "openai-responses",
      defaultModel: "custom-model",
      baseURL: server.baseURL,
    }).chatStream({ payload: { input: "SSE" } });
    let output = "";
    for await (const chunk of stream) output += chunk.deltaText;
    expect(output).toBe("안녕");
    expect((await stream.finalResponse).outputText).toBe("안녕");
  });

  it("propagates workflow cancellation to native streams when only payload is supplied", async () => {
    let disconnected = false;
    const server = await mock((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        frame({ type: "response.output_text.delta", delta: "waiting" }),
      );
      response.on("close", () => (disconnected = true));
    });
    class WaitingTask extends Task {
      name = "waiting";
      memoryPhase = "EXECUTION" as const;
      memoryTaskType = "workflow" as const;
      async run(ctx: WorkflowContext) {
        const stream = await ctx.ai.chatStream({ payload: { input: "wait" } });
        for await (const _chunk of stream) {
          /* Await terminal response or cancellation. */
        }
        await stream.finalResponse;
        return { status: "success" as const };
      }
    }
    const cycle = createCycle({
      aiProvider: createAIProvider({
        apiType: "openai-responses",
        defaultModel: "custom-model",
        baseURL: server.baseURL,
      }),
    });
    cycle.register("waiting", {
      name: "waiting",
      start: "waiting",
      tasks: { waiting: new WaitingTask() },
      transitions: { waiting: "end" },
    });
    const pending = cycle.run("waiting", createWorkflowInput({}));
    await expect.poll(() => server.requests.length).toBe(1);
    await cycle.cancelActiveRuns("test native cancellation");
    expect((await pending).frame.status).toBe("fail");
    await expect.poll(() => disconnected).toBe(true);
  });

  it("requires an object payload in replacement mode instead of silently sending common fields", async () => {
    const provider = createAIProvider({
      apiType: "openai-responses",
      defaultModel: "custom-model",
    });
    await expect(
      provider.chat({
        payloadMode: "replace",
        messages: [{ role: "user", content: "ignored" }],
      }),
    ).rejects.toThrow("requires payload");
    await expect(
      provider.chat({ payload: [] as unknown as Record<string, unknown> }),
    ).rejects.toThrow("payload must be an object");
  });
});

describe("Request routing and retry cancellation", () => {
  it("honors a request baseURL even when the Chat Completions client has an explicit default", async () => {
    const initial = await mock((_request, response) =>
      sendJSON(response, responseBody("openai-chat-completions")),
    );
    const selected = await mock((_request, response) =>
      sendJSON(response, responseBody("openai-chat-completions")),
    );
    const provider = createAIProvider({
      apiKey: "local",
      defaultModel: "custom-model",
      baseURL: initial.baseURL,
    });
    await provider.chat({
      payload: nativeInput("openai-chat-completions"),
      http: { baseURL: selected.baseURL },
    });
    expect(initial.requests).toHaveLength(0);
    expect(selected.requests).toHaveLength(1);
  });
  it("aborts during a server-directed retry delay without sending another generation request", async () => {
    const server = await mock((_request, response) => {
      response.writeHead(429, {
        "content-type": "application/json",
        "retry-after": "30",
      });
      response.end(
        JSON.stringify({ error: { message: "wait before retrying" } }),
      );
    });
    const controller = new AbortController();
    const pending = createAIProvider({
      apiType: "openai-responses",
      defaultModel: "custom-model",
      baseURL: server.baseURL,
    }).chat({
      payload: { input: "cancel retry" },
      http: { signal: controller.signal },
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(
      AIProviderRequestError,
    );
    await expect.poll(() => server.requests.length).toBe(1);
    controller.abort();
    await rejected;
    expect(server.requests).toHaveLength(1);
  });
});

describe("Native conversation compatibility", () => {
  it("uses Responses input content types for assistant history and preserves image detail", async () => {
    const server = await mock((_request, response) =>
      sendJSON(response, responseBody("openai-responses")),
    );
    await createAIProvider({
      apiType: "openai-responses",
      defaultModel: "custom-model",
      baseURL: server.baseURL,
    }).chat({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "previous answer" }],
        },
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: "https://example.test/image.png",
                detail: "low",
              },
            },
          ],
        },
      ],
    });
    expect(server.requests[0]?.body.input).toEqual([
      {
        role: "assistant",
        content: [{ type: "input_text", text: "previous answer" }],
      },
      {
        role: "user",
        content: [
          {
            type: "input_image",
            image_url: "https://example.test/image.png",
            detail: "low",
          },
        ],
      },
    ]);
  });
  it("keeps an Anthropic native default token limit instead of replacing it with a convenience default", async () => {
    const server = await mock((_request, response) =>
      sendJSON(response, responseBody("anthropic-messages")),
    );
    await createAIProvider({
      apiType: "anthropic-messages",
      defaultModel: "custom-model",
      baseURL: server.baseURL,
      defaultPayload: { max_tokens: 8192 },
    }).chat({ payload: nativeInput("anthropic-messages") });
    expect(server.requests[0]?.body.max_tokens).toBe(8192);
  });
});
