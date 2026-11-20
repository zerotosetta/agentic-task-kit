import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { startSessionHttp } from "../src/sessions/http.js";

describe("session HTTP transport", () => {
  let server: Awaited<ReturnType<typeof startSessionHttp>>;
  let base: string;
  const tools = {
    listTools: () => [{ name: "sample", description: "", inputSchema: { type: "object" } }],
    call: vi.fn(async (_name: string, args: Record<string, unknown>) => {
      if (args.fail) throw Object.assign(new Error("Missing session."), { code: "SESSION_NOT_FOUND" });
      return { value: 42 };
    }),
  };
  const headers = { authorization: "Bearer test", "content-type": "application/json", accept: "application/json, text/event-stream" };
  beforeAll(async () => {
    server = await startSessionHttp(tools, { host: "127.0.0.1", port: 0, token: "test", version: "test" });
    base = "http://127.0.0.1:" + server.port;
  });
  afterAll(() => server.close());
  function post(path: string, payload: unknown, extra: Record<string, string> = {}) {
    return fetch(base + path, { method: "POST", headers: { ...headers, ...extra }, body: JSON.stringify(payload) });
  }
  it("checks the wire Host and exact configured proxy origin", async () => {
    const proxy = await startSessionHttp(tools, { host: "127.0.0.1", port: 0, token: "test",
      version: "test", origin: "https://dashboard.example" });
    function status(host: string, origin: string) {
      return new Promise<number | undefined>((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: proxy.port, path: "/app", headers: { host, origin } }, res => {
          res.resume();
          resolve(res.statusCode);
        });
        req.once("error", reject);
        req.end();
      });
    }
    try {
      expect(await status("dashboard.example", "https://dashboard.example")).toBe(200);
      expect(await status("unrelated.example", "https://dashboard.example")).toBe(403);
      expect(await status("dashboard.example", "http://dashboard.example")).toBe(403);
    } finally { await proxy.close(); }
  });
  it("serves the public shell and authenticates every tool call", async () => {
    expect((await fetch(base + "/app/sessions/abc")).headers.get("content-type")).toMatch(/html/);
    const path = "/api/tools/sample";
    expect((await post(path, {}, { authorization: "" })).status).toBe(401);
    expect((await post(path, {}, { origin: "https://unrelated.example" })).status).toBe(403);
    expect((await post(path, {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(await (await post(path, {}, { origin: base })).json()).toEqual({ value: 42 });
    const missing = await post(path, { fail: true });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "SESSION_NOT_FOUND", message: "Missing session." } });
    expect((await post(path, { data: "x".repeat(8 * 1024 * 1024) })).status).toBe(413);
  });
  it("negotiates MCP and returns stateless tool results", async () => {
    const rpc = (method: string, params = {}) => ({ jsonrpc: "2.0", method, id: 1, params });
    const init = await post("/mcp", rpc("initialize", { capabilities: {}, clientInfo: { name: "test", version: "1" }, protocolVersion: "future" }));
    expect((await init.json()).result.protocolVersion).toBe("2025-11-25");
    expect((await post("/mcp", rpc("ping"), { accept: "application/json" })).status).toBe(406);
    expect((await post("/mcp", rpc("ping"), { "mcp-protocol-version": "unknown" })).status).toBe(400);
    const notification = await post("/mcp", { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
    expect((await fetch(base + "/mcp", { headers })).status).toBe(405);
    expect((await (await post("/mcp", rpc("tools/list"))).json()).result.tools[0].name).toBe("sample");
    for (const fail of [true, false]) {
      const call = await post("/mcp", rpc("tools/call", { name: "sample", arguments: { fail } }));
      const { result } = await call.json();
      expect(result.isError).toBe(fail);
      expect(result.structuredContent).toEqual(JSON.parse(result.content[0].text));
    }
  });
});
