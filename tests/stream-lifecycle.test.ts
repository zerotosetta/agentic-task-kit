import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { AIProviderRequestError, createOpenAICompatibleChatProvider } from "../src/index.js";
import { AsyncQueue } from "../src/providers/openai/queue.js";

describe("Streaming lifecycle", () => {
  it("releases queued chunks and cancels the producer when an iterator is returned", async () => {
    const cancel = vi.fn();
    const queue = new AsyncQueue<number>(cancel);
    queue.push(1);
    queue.push(2);
    const iterator = queue[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toBe(1);
    await iterator.return?.();
    await iterator.return?.();
    expect(cancel).toHaveBeenCalledOnce();
    expect((await iterator.next()).done).toBe(true);
  });
  it("preserves an undefined rejection reason rather than leaving future reads pending", async () => {
    const queue = new AsyncQueue<number>();
    queue.fail(undefined);
    await expect(queue[Symbol.asyncIterator]().next()).rejects.toBeUndefined();
  });
  it("aborts the HTTP stream when the consumer breaks early", async () => {
    let disconnected = false;
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = () =>
        res.write(
          `data: ${JSON.stringify({ id: "stream", object: "chat.completion.chunk", model: "mock", choices: [{ index: 0, delta: { content: "chunk" }, finish_reason: null }] })}\n\n`,
        );
      send();
      const timer = setInterval(send, 20);
      res.on("close", () => {
        disconnected = true;
        clearInterval(timer);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const provider = createOpenAICompatibleChatProvider({
        apiKey: "local",
        defaultModel: "mock",
        baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
        maxRetries: 0,
      });
      const stream = await provider.chatStream({ messages: [{ role: "user", content: "stream" }] });
      for await (const chunk of stream) {
        expect(chunk.deltaText).toBe("chunk");
        break;
      }
      await expect(stream.finalResponse).rejects.toBeInstanceOf(AIProviderRequestError);
      await expect.poll(() => disconnected).toBe(true);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
