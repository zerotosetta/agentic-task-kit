import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { connectMcpClient, type McpClient, type McpClientOptions } from "../src/mcp/client.js";
import { evidenceBytes } from "./fixtures/mcp-workflow.js";

const clients: McpClient[] = [];
afterEach(async () => { await Promise.all(clients.splice(0).map(client => client.close())); });

// Independent stdio peer, including behaviors that the ATK server does not produce.
const peer = String.raw`
import { createInterface } from "node:readline";
import { createHash } from "node:crypto";
const mode = process.argv[1];
if (mode === "ignore-eof") setInterval(() => {}, 60_000);
const tool = name => ({ name, description: name, inputSchema: { type: "object" } });
const text = text => ({ content: [{ type: "text", text }] });
let ready = false, effects = 0, cancelled = [];
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  const write = payload => console.log(JSON.stringify({ jsonrpc: "2.0", id, ...payload }));
  const result = result => write({ result });
  if (method === "initialize") {
    if (mode === "hang-init") continue;
    const protocolVersion = mode === "legacy" ? "2025-03-26" : mode === "unsupported" ? "1900-01-01" : params.protocolVersion;
    result({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "peer", version: "1" } });
  } else if (method === "notifications/initialized") {
    ready = true;
  } else if (method === "notifications/cancelled") {
    cancelled.push(params.requestId);
    console.log(JSON.stringify({ jsonrpc: "2.0", id: params.requestId, result: text("too late") }));
  } else if (!ready) {
    write({ error: { code: -32002, message: "not initialized" } });
  } else if (method === "tools/list") {
    if (!params.cursor) result({ tools: [tool("upper")], nextCursor: "more" });
    else if (mode === "loop") result({ tools: [], nextCursor: "more" });
    else result({ tools: [tool("lower")] });
  } else if (method === "tools/call") {
    switch (params.name) {
      case "upper": result(text(params.arguments.value.toUpperCase())); break;
      case "modern": result({ ...text("compat"), structuredContent: { value: 42 } }); break;
      case "legacy": result(text(JSON.stringify({ value: 42 }))); break;
      case "mixed": result({ content: [{ type: "text", text: "a" }, { type: "image", mimeType: "image/png", data: "AA==" }] }); break;
      case "error": result({ ...text(JSON.stringify({ code: "UPSTREAM_FAILURE", message: "example failure" })), isError: true }); break;
      case "rpc": write({ error: { code: -32602, message: "unknown tool" } }); break;
      case "delay": setTimeout(() => result(text(params.arguments.value)), params.arguments.delay); break;
      case "effect": effects++; break;
      case "count": result(text(JSON.stringify({ cancelled: cancelled.length, effects }))); break;
      case "malformed": console.log("{}"); break;
      case "overflow": console.log("x".repeat(1048577)); break;
      case "exit": process.exit(7); break;
      case "workflow_results": {
        const bytes = Buffer.from("hello");
        const digest = createHash("sha256").update(bytes).digest("hex");
        const { artifactId, runId, cursor, maxBytes } = params.arguments;
        const offset = Number(cursor || "0"), end = Math.min(offset + maxBytes, bytes.length);
        const page = { runId, artifact: { kind: "text", id: artifactId, sha256: digest },
          checkpointSeq: 3, offset, totalBytes: bytes.length,
          data: bytes.subarray(offset, end).toString("base64"), nextCursor: end < bytes.length ? String(end) : null };
        if (mode === "bad-hash") page.artifact.sha256 = "f".repeat(64);
        if (mode === "short") page.nextCursor = null;
        if (mode === "offset" && cursor) page.offset = 0;
        if (mode === "checkpoint" && cursor) page.checkpointSeq = 4;
        if (mode === "length" && cursor) page.totalBytes++;
        if (mode === "base64") page.data += "!";
        result(text(JSON.stringify(page)));
        break;
      }
    }
  }
}
`;

async function open(mode = "default", options: Partial<McpClientOptions> = {}) {
  const client = await connectMcpClient({
    command: process.execPath, args: ["--input-type=module", "-e", peer, mode], ...options,
  });
  clients.push(client);
  return client;
}

describe("outgoing MCP client", () => {
  it("negotiates, discovers paginated tool declarations and runs concurrent arbitrary tools", async () => {
    const client = await open();
    expect(client.protocolVersion).toBe("2025-11-25");
    expect((await client.listTools()).map(tool => tool.name)).toEqual(["upper", "lower"]);
    expect(await Promise.all([
      client.callToolValue("delay", { value: "first", delay: 30 }),
      client.callToolValue("delay", { value: "second", delay: 0 }),
    ])).toEqual(["first", "second"]);
    expect(await client.callTool("upper", { value: "hello" })).toEqual({ content: [{ type: "text", text: "HELLO" }] });
    expect(await client.callToolValue("modern")).toEqual({ value: 42 });
    expect(await client.callToolValue("mixed")).toEqual([
      { type: "text", text: "a" }, { type: "image", mimeType: "image/png", data: "AA==" },
    ]);
    await expect(client.callTool("error")).rejects.toMatchObject({ code: "UPSTREAM_FAILURE", message: "example failure" });
    await expect(client.callTool("rpc")).rejects.toMatchObject({ code: -32602 });
  });

  it("accepts negotiated legacy JSON text and rejects unsupported versions or repeated discovery cursors", async () => {
    const legacy = await open("legacy");
    expect(legacy.protocolVersion).toBe("2025-03-26");
    expect(await legacy.callToolValue("legacy")).toEqual({ value: 42 });
    await expect(open("unsupported")).rejects.toThrow("protocol version");
    const looping = await open("loop");
    await expect(looping.listTools()).rejects.toThrow("cursor");
  });

  it("cancels and times out requests once and ignores their late replies", async () => {
    const client = await open("default", { timeoutMs: 2_000 });
    const abort = new AbortController();
    const interrupted = client.callTool("effect", {}, { signal: abort.signal });
    abort.abort(new Error("stop step"));
    await expect(interrupted).rejects.toThrow("stop step");
    await expect(client.callTool("effect")).rejects.toThrow("timed out");
    await expect(client.callToolValue("count")).resolves.toEqual({ effects: 2, cancelled: 2 });
  }, 10_000);

  it("rejects pending calls on disconnect, malformed or oversized output, and closes idempotently", async () => {
    for (const tool of ["malformed", "overflow", "exit"]) {
      const client = await open();
      const pending = client.callTool("effect");
      await expect(Promise.all([pending, client.callTool(tool)])).rejects.toThrow();
      await Promise.all([client.close(), client.close()]);
      await expect(client.listTools()).rejects.toThrow();
    }
    const controller = new AbortController();
    const client = await open("default", { signal: controller.signal });
    const pending = client.callTool("effect");
    controller.abort(new Error("stop server"));
    await expect(pending).rejects.toThrow("stop server");
    await expect(open("hang-init", { timeoutMs: 100 })).rejects.toThrow("timed out");
  }, 15_000);

  it("checks artifact length, offset, checkpoint, encoding, limits and pinned digest", async () => {
    for (const [mode, message] of [
      ["bad-hash", "SHA-256"], ["short", "length"], ["offset", "page"],
      ["checkpoint", "checkpoint"], ["length", "length"], ["base64", "encoding"],
    ] as const) {
      const client = await open(mode);
      await expect(client.readWorkflowArtifact("r", "a", { pageBytes: 2 })).rejects.toThrow(message);
    }
    const client = await open();
    await expect(client.readWorkflowArtifact("r", "a", { maxTotalBytes: 4 })).rejects.toThrow("maxTotalBytes");
    const ref = { id: "a", kind: "text", sha256: "0".repeat(64) };
    await expect(client.readWorkflowArtifact("r", ref)).rejects.toThrow("SHA-256");
    expect(Buffer.from(await client.readWorkflowArtifact("r", "a", { pageBytes: 2 })).toString()).toBe("hello");
  }, 15_000);

  it("bounds writes and outstanding requests and closes a peer that ignores EOF", async () => {
    const client = await open("ignore-eof");
    await expect(client.callTool("effect", { large: "x".repeat(1024 * 1024) })).rejects.toThrow("line size");
    const running = Array.from({ length: 64 }, () => client.callTool("effect"));
    const settled = Promise.allSettled(running);
    await expect(client.callTool("effect")).rejects.toThrow("pending MCP requests");
    await client.close();
    expect((await settled).every(item => item.status === "rejected")).toBe(true);
    await expect(open("default", { command: join(tmpdir(), "atk-nonexistent-server-command") })).rejects.toThrow();
  });

  it("runs the real ATK CLI and downloads committed bytes through workflow_results", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atk-sdk-client-"));
    try {
      const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));
      await build({
        entryPoints: { cli: src("../src/mcp/cli.ts"), plugin: src("./fixtures/mcp-workflow.ts") },
        outdir: dir, outExtension: { ".js": ".mjs" }, bundle: true, platform: "node", format: "esm", target: "node22",
      });
      const config = join(dir, "mcp.json");
      await writeFile(config, JSON.stringify({ stateDirectory: "./state", profiles: {
        test: { module: "./plugin.mjs", revision: "test-v1", settings: { controlDirectory: dir } },
      } }));
      const client = await open("default", { args: [join(dir, "cli.mjs"), "--config", config] });
      const { runId } = await client.callToolValue("workflow_start", {
        profile: "test", request: { mode: "normal" }, idempotencyKey: "test-sdk",
      }) as { runId: string };
      await expect.poll(() => client.callToolValue("workflow_status", { runId }),
        { timeout: 15_000, interval: 100 }).toMatchObject({ status: "completed" });
      const { artifacts } = await client.callToolValue("workflow_results", { runId }) as {
        artifacts: { id: string; kind: string; sha256: string }[];
      };
      const ref = artifacts.find(entry => entry.kind === "fixture-spec")!;
      expect(Buffer.from(await client.readWorkflowArtifact(runId, ref, { pageBytes: 3 })).toString()).toBe(evidenceBytes);
    } finally {
      await Promise.all(clients.splice(0).map(client => client.close()));
      await rm(dir, { force: true, recursive: true, maxRetries: 5 });
    }
  }, 25_000);
});
