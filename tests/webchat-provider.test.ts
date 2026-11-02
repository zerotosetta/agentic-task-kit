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
  createWebChatAIProvider,
  createWorkflowInput,
  type WebChatProviderSettings,
  type WorkflowContext,
} from "../src/index.js";

type Request = {
  method: string;
  path: string;
  body: Record<string, unknown>;
  headers: IncomingHttpHeaders;
};
type Session = {
  session_id: string;
  llm_id: string;
  message_history: Array<{ message_id: number; contents: string }>;
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
function json(response: ServerResponse, value: unknown, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json",
    "x-request-id": "mock-request",
  });
  response.end(JSON.stringify(value));
}
async function server(
  options: {
    inline?: boolean;
    pollAfter?: number;
    intercept?: (
      request: Request,
      response: ServerResponse,
      index: number,
    ) => boolean;
  } = {},
) {
  const requests: Request[] = [];
  const sessions = new Map<string, Session>();
  const polls = new Map<string, number>();
  let messageId = 0;
  const add = (session: Session, body: Record<string, unknown>) =>
    session.message_history.push({
      message_id: ++messageId,
      contents: JSON.stringify(body),
    });
  const get = (id: string) => {
    let session = sessions.get(id);
    if (!session) {
      session = { session_id: id, llm_id: "mock-model", message_history: [] };
      sessions.set(id, session);
    }
    return session;
  };
  const http = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += String(chunk);
    const captured = {
      method: request.method ?? "GET",
      path: request.url ?? "",
      body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
      headers: request.headers,
    };
    requests.push(captured);
    if (options.intercept?.(captured, response, requests.length)) return;
    if (
      captured.path === "/action-webchat/post/sessions" &&
      captured.method === "POST"
    ) {
      const session = get(`session-${sessions.size + 1}`);
      session.llm_id = String(captured.body.llm_id);
      json(response, { ...session, message_count: 0 });
      return;
    }
    const append =
      /^\/action-webchat\/post\/sessions\/([^/]+)\/messages$/u.exec(
        captured.path,
      );
    if (append && captured.method === "POST") {
      const session = get(decodeURIComponent(append[1]!));
      add(session, captured.body);
      if (options.inline && captured.body.role === "user")
        add(session, {
          role: "assistant",
          content: `reply:${String(captured.body.content)}`,
        });
      json(response, {
        ...session,
        message_count: session.message_history.length,
        first_message: session.message_history[0]?.contents,
      });
      return;
    }
    const answer = /^\/mock\/answers\/([^/?]+)/u.exec(captured.path);
    if (answer && captured.method === "GET") {
      const id = decodeURIComponent(answer[1]!);
      const session = get(id);
      const count = (polls.get(id) ?? 0) + 1;
      polls.set(id, count);
      if (
        count >= (options.pollAfter ?? 2) &&
        JSON.parse(session.message_history.at(-1)?.contents ?? "{}").role ===
          "user"
      )
        add(session, { role: "assistant", content: "polled answer" });
      json(response, {
        ...session,
        status: count >= (options.pollAfter ?? 2) ? "done" : "waiting",
      });
      return;
    }
    if (/^\/mock\/generate\//u.test(captured.path)) {
      json(response, { accepted: true });
      return;
    }
    json(response, { error: { message: "unexpected mock path" } }, 404);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  });
  const baseURL = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  const provider = (webChat: WebChatProviderSettings = {}) =>
    createWebChatAIProvider({
      baseURL,
      apiKey: "mock-api-key",
      defaultModel: "mock-model",
      webChat: { assistantUUID: "mock-assistant", ...webChat },
    });
  return { requests, sessions, add, get, baseURL, provider };
}
const message = (content = "hello") => ({ role: "user", content });
const poll: WebChatProviderSettings = {
  completion: {
    mode: "poll",
    path: "/mock/answers/{sessionId}",
    intervalMs: 0,
    maxAttempts: 3,
  },
};

describe("HAR WebChat protocol", () => {
  it("exposes the two observed operations without requiring a guessed answer endpoint", async () => {
    const mock = await server();
    const provider = mock.provider();
    const session = await provider.createSession({
      webChat: {
        title: "test conversation",
        sessionPayload: { vendor_extra: true },
      },
    });
    expect(session.sessionId).toBe("session-1");
    expect(mock.requests[0]?.body).toEqual({
      title: "test conversation",
      assistant_uuid: "mock-assistant",
      llm_id: "mock-model",
      vendor_extra: true,
    });
    expect(mock.requests[0]?.headers["bxcode-user-api-key"]).toBe(
      "mock-api-key",
    );
    expect(mock.requests[0]?.headers["max-session-count"]).toBe("100");
    const result = await provider.appendMessage(session.sessionId, message());
    expect(mock.requests[1]?.body).toEqual(message());
    expect((result as Session).message_history[0]?.contents).toBe(
      JSON.stringify(message()),
    );
  });
  it("fails before any side effects when chat completion is not configured", async () => {
    const mock = await server();
    await expect(mock.provider().chat({ payload: message() })).rejects.toThrow(
      "explicit completion mode",
    );
    expect(mock.requests).toHaveLength(0);
  });
  it("does not treat a user acknowledgement or an older assistant message as a new answer", async () => {
    const mock = await server();
    mock.add(mock.get("existing"), {
      role: "assistant",
      content: "old answer",
    });
    const provider = mock.provider({
      sessionId: "existing",
      completion: { mode: "append" },
    });
    await expect(
      provider.chat({ payload: message("new question") }),
    ).rejects.toMatchObject({
      code: "webchat_response_pending",
      responseBody: { session_id: "existing" },
    });
    expect(mock.requests).toHaveLength(1);
  });
  it("normalizes a newly appended assistant message from JSON-encoded history", async () => {
    const mock = await server({ inline: true });
    const result = await mock
      .provider({ completion: { mode: "append" } })
      .chat({ messages: [{ role: "user", content: "hello" }] });
    expect(result.outputText).toBe("reply:hello");
    expect(result.model).toBe("mock-model");
    expect(result.raw).toMatchObject({
      session_id: "session-1",
      buffered: true,
    });
  });
  it("preserves native fields and literal placeholders in message and session payloads", async () => {
    const mock = await server({ inline: true });
    const payload = {
      ...message("literal {sessionId} {model}"),
      attachments: [{ path: "{messageId}" }],
      vendor_field: { unknown: true },
    };
    await mock
      .provider({
        completion: { mode: "append" },
        sessionPayload: { title: "literal {model}" },
      })
      .chat({ payload });
    expect(mock.requests[0]?.body.title).toBe("literal {model}");
    expect(mock.requests[1]?.body).toEqual(payload);
    expect(payload).not.toHaveProperty("session_id");
  });
  it("sends common history in order and applies request payload only to the last message", async () => {
    const mock = await server({ inline: true });
    const provider = createWebChatAIProvider({
      baseURL: mock.baseURL,
      defaultModel: "mock-model",
      defaultPayload: { flag: "default" },
      webChat: {
        assistantUUID: "mock-assistant",
        completion: { mode: "append" },
      },
    });
    await provider.chat({
      messages: [
        { role: "system", content: "policy" },
        { role: "user", content: "question" },
      ],
      payload: { flag: "request", extra: true },
    });
    expect(mock.requests.slice(1).map((request) => request.body)).toEqual([
      { flag: "default", role: "system", content: "policy" },
      { flag: "request", role: "user", content: "question", extra: true },
    ]);
  });
  it("replacement mode skips common messages and defaults", async () => {
    const mock = await server({ inline: true });
    const provider = createWebChatAIProvider({
      baseURL: mock.baseURL,
      defaultModel: "mock-model",
      defaultPayload: { ignored: true },
      webChat: {
        assistantUUID: "mock-assistant",
        completion: { mode: "append" },
      },
    });
    await provider.chat({
      payloadMode: "replace",
      payload: message(),
      messages: [{ role: "user", content: "ignored" }],
    });
    expect(mock.requests).toHaveLength(2);
    expect(mock.requests[1]?.body).toEqual(message());
  });
});

describe("Configured WebChat completion", () => {
  it("polls an explicit endpoint and optionally triggers generation without inventing API paths", async () => {
    const mock = await server();
    const result = await mock
      .provider({
        completion: {
          mode: "poll",
          path: "/mock/answers/{sessionId}",
          trigger: {
            path: "/mock/generate/{sessionId}",
            method: "POST",
            templatePayload: true,
            payload: {
              session: "{sessionId}",
              message: "{messageId}",
              model: "{model}",
            },
          },
          intervalMs: 0,
          maxAttempts: 3,
        },
        readyWhen: { path: ["status"], equals: "done" },
      })
      .chat({ payload: message() });
    expect(result.outputText).toBe("polled answer");
    expect(mock.requests[2]?.body).toEqual({
      session: "session-1",
      message: 1,
      model: "mock-model",
    });
    expect(mock.requests.slice(3).map((request) => request.method)).toEqual([
      "GET",
      "GET",
    ]);
  });
  it("uses configured session paths, nested IDs, answer paths, and encoded path values", async () => {
    const mock = await server({
      intercept(request, response) {
        if (request.path === "/custom/create") {
          json(response, { data: { id: "한글/세션" } });
          return true;
        }
        if (request.path.startsWith("/custom/message/")) {
          json(response, { stored: true });
          return true;
        }
        if (request.path.startsWith("/custom/answer/")) {
          json(response, { data: { answer: "custom answer" } });
          return true;
        }
        return false;
      },
    });
    const result = await mock
      .provider({
        createSessionPath: "/custom/create",
        sessionIdPath: ["data", "id"],
        appendMessagePath: "/custom/message/{sessionId}",
        responsePath: ["data", "answer"],
        completion: { mode: "request", path: "/custom/answer/{sessionId}" },
      })
      .chat({ payload: message() });
    expect(result.outputText).toBe("custom answer");
    expect(mock.requests[1]?.path).toBe(
      `/custom/message/${encodeURIComponent("한글/세션")}`,
    );
  });
  it("supports custom generation and extraction callbacks with the same cancellation context", async () => {
    const mock = await server();
    const result = await mock
      .provider({
        completion: {
          mode: "custom",
          async complete(context) {
            expect(context.messageId).toBe(1);
            expect(context.signal.aborted).toBe(false);
            await context.send({
              path: "/mock/generate/{sessionId}",
              method: "POST",
            });
            return { generated: "callback answer" };
          },
        },
        extractAssistant(raw) {
          return {
            text: (raw as { generated: string }).generated,
            usage: { outputTokens: 8 },
          };
        },
      })
      .chat({ payload: message() });
    expect(result.outputText).toBe("callback answer");
    expect(result.usage?.outputTokens).toBe(8);
  });
  it("waits for an explicit readiness condition rather than returning a draft", async () => {
    let reads = 0;
    const mock = await server({
      intercept(request, response) {
        if (request.path === "/custom/status") {
          reads++;
          json(response, {
            status: reads === 1 ? "draft" : "done",
            answer: reads === 1 ? "partial" : "final",
          });
          return true;
        }
        return false;
      },
    });
    const result = await mock
      .provider({
        completion: {
          mode: "poll",
          path: "/custom/status",
          intervalMs: 0,
          maxAttempts: 2,
        },
        responsePath: ["answer"],
        readyWhen: { path: ["status"], equals: "done" },
      })
      .chat({ payload: message() });
    expect(result.outputText).toBe("final");
    expect(reads).toBe(2);
  });
  it("exposes session identity on exhausted polling instead of returning user text", async () => {
    const mock = await server({ pollAfter: 100 });
    await expect(
      mock.provider(poll).chat({ payload: message() }),
    ).rejects.toMatchObject({
      code: "webchat_response_pending",
      responseBody: { session_id: "session-1" },
    });
  });
  it("validates incomplete completion configuration before creating a session", async () => {
    const mock = await server();
    await expect(
      mock
        .provider({ completion: { mode: "request", path: "" } })
        .chat({ payload: message() }),
    ).rejects.toThrow("non-empty path");
    await expect(
      mock
        .provider({
          completion: { mode: "poll", path: "/mock/status", maxAttempts: 0 },
        })
        .chat({ payload: message() }),
    ).rejects.toThrow("polling requires");
    expect(mock.requests).toHaveLength(0);
  });
});

describe("WebChat session lifecycle", () => {
  it("isolates concurrent calls in separate sessions by default", async () => {
    const mock = await server({ inline: true });
    const provider = mock.provider({ completion: { mode: "append" } });
    const results = await Promise.all([
      provider.chat({ payload: message("one") }),
      provider.chat({ payload: message("two") }),
    ]);
    expect(
      new Set(
        results.map(
          (result) => (result.raw as { session_id: string }).session_id,
        ),
      ).size,
    ).toBe(2);
    expect(mock.sessions.size).toBe(2);
  });
  it("serializes explicitly reused sessions until completion, including failed calls", async () => {
    const mock = await server();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const order: string[] = [];
    const provider = mock.provider({
      sessionId: "shared",
      completion: {
        mode: "custom",
        async complete(context) {
          const input = String(context.lastMessage.content);
          order.push(input);
          if (input === "one") await gate;
          if (input === "failure") throw new Error("custom failure");
          return { role: "assistant", content: input };
        },
      },
    });
    const first = provider.chat({ payload: message("one") });
    const second = provider.chat({ payload: message("two") });
    await expect.poll(() => order.length).toBe(1);
    expect(mock.requests).toHaveLength(1);
    release();
    expect(
      (await Promise.all([first, second])).map(
        (response) => response.outputText,
      ),
    ).toEqual(["one", "two"]);
    await expect(
      provider.chat({ payload: message("failure") }),
    ).rejects.toThrow("custom failure");
    expect(
      (await provider.chat({ payload: message("after failure") })).outputText,
    ).toBe("after failure");
  });
  it("removes cancelled queued requests without letting later requests overtake an active call", async () => {
    const mock = await server();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const provider = mock.provider({
      sessionId: "shared",
      completion: {
        mode: "custom",
        async complete(context) {
          if (context.lastMessage.content === "one") await gate;
          return {
            role: "assistant",
            content: String(context.lastMessage.content),
          };
        },
      },
    });
    const first = provider.chat({ payload: message("one") });
    await expect.poll(() => mock.requests.length).toBe(1);
    const controller = new AbortController();
    const queued = provider.chat({
      payload: message("cancel"),
      http: { signal: controller.signal },
    });
    const rejected = expect(queued).rejects.toBeInstanceOf(
      AIProviderRequestError,
    );
    controller.abort();
    await rejected;
    const third = provider.chat({ payload: message("three") });
    expect(mock.requests).toHaveLength(1);
    release();
    await first;
    expect((await third).outputText).toBe("three");
    expect(mock.requests.map((request) => request.body.content)).toEqual([
      "one",
      "three",
    ]);
  });
  it("does not automatically retry state-changing POST requests", async () => {
    const mock = await server({
      intercept(_request, response) {
        json(
          response,
          {
            error: { code: "write_failed", message: "write may have happened" },
          },
          503,
        );
        return true;
      },
    });
    const provider = createWebChatAIProvider({
      baseURL: mock.baseURL,
      defaultModel: "mock-model",
      maxRetries: 5,
      webChat: {
        assistantUUID: "mock-assistant",
        completion: { mode: "append" },
      },
    });
    await expect(provider.chat({ payload: message() })).rejects.toMatchObject({
      status: 503,
      code: "write_failed",
      requestId: "mock-request",
    });
    expect(mock.requests).toHaveLength(1);
  });
  it("retries transient GET failures without re-posting sessions or messages", async () => {
    let reads = 0;
    const mock = await server({
      pollAfter: 1,
      intercept(request, response) {
        if (request.method === "GET" && ++reads === 1) {
          json(response, { error: { message: "temporary" } }, 503);
          return true;
        }
        return false;
      },
    });
    expect(
      (await mock.provider(poll).chat({ payload: message() })).outputText,
    ).toBe("polled answer");
    expect(
      mock.requests.filter((request) => request.method === "POST"),
    ).toHaveLength(2);
    expect(reads).toBe(2);
  });
  it("applies an overall timeout and cancels an in-flight completion request", async () => {
    let closed = false;
    const mock = await server({
      intercept(request, response) {
        if (request.method === "GET") {
          response.on("close", () => (closed = true));
          return true;
        }
        return false;
      },
    });
    const provider = createWebChatAIProvider({
      baseURL: mock.baseURL,
      defaultModel: "mock-model",
      timeoutMs: 1000,
      webChat: { assistantUUID: "mock-assistant", ...poll },
    });
    await expect(provider.chat({ payload: message() })).rejects.toBeInstanceOf(
      AIProviderRequestError,
    );
    await expect.poll(() => closed).toBe(true);
  });
  it("aborts poll delays and buffered streams when the iterator is returned", async () => {
    const mock = await server({ pollAfter: 100 });
    const provider = mock.provider({
      completion: {
        mode: "poll",
        path: "/mock/answers/{sessionId}",
        intervalMs: 10_000,
        maxAttempts: 10,
      },
    });
    const stream = await provider.chatStream({ payload: message() });
    await expect
      .poll(() => mock.requests.some((request) => request.method === "GET"))
      .toBe(true);
    await stream[Symbol.asyncIterator]().return?.();
    await expect(stream.finalResponse).rejects.toBeInstanceOf(
      AIProviderRequestError,
    );
  });
  it("delivers JSON completion as one truthful buffered chunk", async () => {
    const mock = await server({ inline: true });
    const stream = await mock
      .provider({ completion: { mode: "append" } })
      .chatStream({ payload: message() });
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.deltaText).toBe("reply:hello");
    expect(chunks[0]?.raw).toMatchObject({ buffered: true });
    expect((await stream.finalResponse).outputText).toBe("reply:hello");
  });
  it("rejects an unconfigured SSE protocol promptly instead of buffering forever", async () => {
    const mock = await server({
      intercept(request, response) {
        if (request.path === "/mock/sse") {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write("data: {}\n\n");
          return true;
        }
        return false;
      },
    });
    await expect(
      mock
        .provider({ completion: { mode: "request", path: "/mock/sse" } })
        .chat({ payload: message() }),
    ).rejects.toThrow("received SSE");
    expect(
      mock.requests.filter((request) => request.method === "GET"),
    ).toHaveLength(1);
  });
});

describe("WebChat configuration and runtime integration", () => {
  it("integrates with generic factory and workflow monitoring", async () => {
    const mock = await server({ inline: true });
    const provider = createAIProvider({
      apiType: "webchat",
      baseURL: mock.baseURL,
      defaultModel: "mock-model",
      webChat: {
        assistantUUID: "mock-assistant",
        completion: { mode: "append" },
      },
    });
    const logs: unknown[] = [];
    class WebChatTask extends Task {
      name = "chat";
      memoryPhase = "EXECUTION" as const;
      memoryTaskType = "workflow" as const;
      async run(ctx: WorkflowContext) {
        const result = await ctx.ai.chat({ payload: message() });
        return { status: "success" as const, output: result.outputText };
      }
    }
    const cycle = createCycle({
      aiProvider: provider,
      observers: [
        {
          onEvent() {},
          onTaskLog(log) {
            logs.push(log);
          },
        },
      ],
    });
    cycle.register("chat", {
      name: "chat",
      start: "chat",
      tasks: { chat: new WebChatTask() },
      transitions: { chat: "end" },
    });
    expect(
      (await cycle.run("chat", createWorkflowInput({}))).frame.status,
    ).toBe("success");
    expect(logs).toContainEqual(
      expect.objectContaining({
        message: "AI chat request",
        meta: expect.objectContaining({ apiType: "webchat" }),
      }),
    );
  });
  it("merges WebChat file configuration with callback overrides", async () => {
    const mock = await server();
    const temp = await mkdtemp(join(tmpdir(), "webchat config "));
    cleanups.push(() => rm(temp, { recursive: true, force: true }));
    const configPath = join(temp, "provider.json");
    await writeFile(
      configPath,
      JSON.stringify({
        apiType: "webchat",
        baseURL: mock.baseURL,
        defaultModel: "mock-model",
        webChat: { assistantUUID: "from-config", maxSessionCount: 50 },
      }),
    );
    const provider = createAIProviderFromConfigFile({
      configPath,
      overrides: {
        webChat: {
          completion: {
            mode: "custom",
            async complete() {
              return { role: "assistant", content: "configured" };
            },
          },
        },
      },
    });
    expect((await provider.chat({ payload: message() })).outputText).toBe(
      "configured",
    );
    expect(mock.requests[0]?.body.assistant_uuid).toBe("from-config");
    expect(mock.requests[0]?.headers["max-session-count"]).toBe("50");
  });
  it("always redacts the configured WebChat authentication header in debug output", async () => {
    const mock = await server({ inline: true });
    const log = new PassThrough();
    let output = "";
    log.on("data", (chunk) => (output += String(chunk)));
    const provider = createWebChatAIProvider({
      baseURL: mock.baseURL,
      apiKey: "private-mock-key",
      defaultModel: "mock-model",
      httpDebugLogging: { stream: log, redactHeaders: [] },
      webChat: {
        apiKeyHeader: "X-WebChat-Secret",
        assistantUUID: "mock-assistant",
        completion: { mode: "append" },
      },
    });
    await provider.chat({ payload: message() });
    expect(mock.requests[0]?.headers["x-webchat-secret"]).toBe(
      "private-mock-key",
    );
    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain("private-mock-key");
  });
});

describe("WebChat native session overrides", () => {
  it("binds the effective assistant and model from native session fields", async () => {
    const mock = await server();
    const provider = mock.provider({
      sessionPayload: {
        assistant_uuid: "default-native-assistant",
        llm_id: "default-native-model",
      },
      completion: {
        mode: "request",
        path: "/mock/generate/{sessionId}",
        method: "POST",
        templatePayload: true,
        payload: { assistant: "{assistantUUID}", model: "{model}" },
      },
      extractAssistant() {
        return { text: "native session answer" };
      },
    });
    const result = await provider.chat({
      payload: message(),
      webChat: {
        sessionPayload: {
          assistant_uuid: "request-native-assistant",
          llm_id: "request-native-model",
        },
      },
    });
    expect(mock.requests[0]?.body).toMatchObject({
      assistant_uuid: "request-native-assistant",
      llm_id: "request-native-model",
    });
    expect(mock.requests[2]?.body).toEqual({
      assistant: "request-native-assistant",
      model: "request-native-model",
    });
    expect(result.model).toBe("request-native-model");
  });
});
