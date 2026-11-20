import { spawn } from "node:child_process";
import { hasText, isRecord, sha256, validateRef } from "../durable-validation.js";
import type { DurableArtifactRef, DurableJSON } from "../types/durable.js";
import { frames, maxFrameBytes, versions } from "./framing.js";

type JsonObject = Readonly<Record<string, DurableJSON>>;
type RequestOptions = { signal?: AbortSignal };
type ToolContent = JsonObject & { type: string };

export interface McpClientOptions extends RequestOptions {
  command: string;
  args?: readonly string[];
  cwd?: string;
  /** Child environment. Omit to inherit the current process environment. */
  env?: NodeJS.ProcessEnv;
  /** Per-request deadline including initialization. Defaults to 30 seconds. */
  timeoutMs?: number;
}

export type McpTool = JsonObject & { name: string; inputSchema: JsonObject };
export type McpToolResult = JsonObject & {
  content: readonly ToolContent[];
  structuredContent?: JsonObject;
  isError?: boolean;
};

export interface McpArtifactReadOptions extends RequestOptions {
  /** The decoded size requested per page. Defaults to 64 KiB. */
  pageBytes?: number;
  /** Maximum artifact size in memory. Defaults to 64 MiB. */
  maxTotalBytes?: number;
}

export interface McpClient {
  readonly protocolVersion: string;
  listTools(options?: RequestOptions): Promise<McpTool[]>;
  /** Returns the original tool envelope. Tool and JSON-RPC errors reject. */
  callTool(name: string, args?: JsonObject, options?: RequestOptions): Promise<McpToolResult>;
  /** Structured result, parsed or plain singleton text, or the complete content array. */
  callToolValue(name: string, args?: JsonObject, options?: RequestOptions): Promise<DurableJSON>;
  /** Fetch all workflow_results pages and verify their identity, length and SHA-256. */
  readWorkflowArtifact(runId: string, artifact: string | DurableArtifactRef, options?: McpArtifactReadOptions): Promise<Uint8Array>;
  close(): Promise<void>;
}

function toolValue(result: McpToolResult): DurableJSON {
  if (result.structuredContent !== undefined) return result.structuredContent;
  const [item] = result.content;
  if (result.content.length !== 1 || item?.type !== "text" || typeof item.text !== "string") return result.content;
  try {
    return JSON.parse(item.text) as DurableJSON;
  } catch {
    return item.text;
  }
}

function checkRange(value: number, min: number, max: number, label: string) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(label + " must be a whole number between " + min + " and " + max + ".");
  }
}

async function readArtifact(
  call: McpClient["callToolValue"], runId: string, artifact: string | DurableArtifactRef,
  options: McpArtifactReadOptions = {},
): Promise<Uint8Array> {
  const artifactId = typeof artifact === "string" ? artifact : artifact.id;
  const pageBytes = options.pageBytes ?? 65_536;
  const limit = options.maxTotalBytes ?? 64 * 1024 * 1024;
  checkRange(pageBytes, 1, 262_144, "pageBytes");
  checkRange(limit, 0, Number.MAX_SAFE_INTEGER, "maxTotalBytes");
  if (!hasText(runId) || !hasText(artifactId)) throw new TypeError("A run ID and artifact ID are required.");
  let reference = typeof artifact === "string" ? undefined : validateRef(artifact, null, "INVALID_INPUT");
  let checkpoint: number | undefined;
  let cursor: string | undefined;
  let buffer: Buffer | undefined;
  let offset = 0;
  do {
    const args = { runId, artifactId, maxBytes: pageBytes, ...(cursor === undefined ? {} : { cursor }) };
    const page = await call("workflow_results", args, options);
    if (!isRecord(page) || page.runId !== runId || page.offset !== offset || !isRecord(page.artifact)
        || page.artifact.id !== artifactId || !hasText(page.artifact.kind) || typeof page.artifact.sha256 !== "string"
        || !/^[0-9a-f]{64}$/u.test(page.artifact.sha256) || typeof page.data !== "string"
        || typeof page.checkpointSeq !== "number" || !Number.isSafeInteger(page.checkpointSeq) || page.checkpointSeq < 0
        || typeof page.totalBytes !== "number" || !Number.isSafeInteger(page.totalBytes) || page.totalBytes < 0
        || (page.nextCursor !== null && (!hasText(page.nextCursor) || page.nextCursor.length > 4096))) {
      throw new Error("Invalid workflow_results artifact page.");
    }
    const { kind, sha256: digest } = page.artifact;
    if ((reference && (reference.sha256 !== digest || reference.kind !== kind))
        || (checkpoint !== undefined && checkpoint !== page.checkpointSeq)
        || (buffer && buffer.length !== page.totalBytes)) {
      throw new Error("Artifact identity, SHA-256, checkpoint or length changed.");
    }
    if (page.totalBytes > limit) throw new Error("Artifact exceeds maxTotalBytes.");
    reference ??= { id: artifactId, kind, sha256: digest };
    checkpoint = page.checkpointSeq;
    const chunk = Buffer.from(page.data, "base64");
    if (chunk.toString("base64") !== page.data || chunk.length > pageBytes || chunk.length > page.totalBytes - offset) {
      throw new Error("Invalid artifact chunk encoding or length.");
    }
    buffer ??= Buffer.alloc(page.totalBytes);
    chunk.copy(buffer, offset);
    offset += chunk.length;
    if (page.nextCursor === null) {
      if (offset !== buffer.length) throw new Error("Incomplete artifact length.");
      if (sha256(buffer) !== reference.sha256) throw new Error("Artifact SHA-256 verification failed.");
      return buffer;
    }
    if (!chunk.length || offset >= buffer.length || cursor === page.nextCursor) throw new Error("Invalid artifact continuation.");
    cursor = page.nextCursor;
  } while (true);
}

/** Start a trusted stdio server, negotiate MCP, and own its process until close(). */
export async function connectMcpClient(options: McpClientOptions): Promise<McpClient> {
  const { command, args, cwd, env, signal } = options;
  const timeoutMs = options.timeoutMs ?? 30_000;
  checkRange(timeoutMs, 1, 2_147_483_647, "timeoutMs");
  if (!hasText(command)) throw new TypeError("An MCP server command is required.");
  signal?.throwIfAborted();
  const child = spawn(command, args ?? [], { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void }>();
  let nextId = 0;
  let stopped: Error | undefined;
  let forceClose: NodeJS.Timeout | undefined;
  let protocolVersion: string | undefined;
  const closed = new Promise<void>(resolve => child.once("close", (code, bySignal) => {
    stop(new Error("MCP server exited (" + (code ?? bySignal) + ")."));
    clearTimeout(forceClose);
    resolve();
  }));

  function stop(error: Error) {
    if (stopped) return;
    stopped = error;
    signal?.removeEventListener("abort", abortConnection);
    for (const request of pending.values()) request.reject(error);
    child.stdin.end();
    forceClose = setTimeout(() => {
      child.kill("SIGKILL");
      child.stdin.destroy();
      child.stdout.destroy();
    }, 300);
    forceClose.unref();
  }
  function abortConnection() {
    stop(signal?.reason instanceof Error ? signal.reason : new Error("MCP connection aborted."));
  }
  function writeMessage(message: object) {
    if (stopped) throw stopped;
    const line = JSON.stringify(message) + "\n";
    if (Buffer.byteLength(line) - 1 > maxFrameBytes) throw new Error("MCP message exceeds the line size limit.");
    if (child.stdin.writableLength > 2 * maxFrameBytes) throw new Error("MCP output queue is full.");
    child.stdin.write(line);
  }
  function send(body: object) { writeMessage({ jsonrpc: "2.0", ...body }); }
  function receive(message: unknown): object | undefined {
    if (!isRecord(message) || message.jsonrpc !== "2.0") throw new Error("Invalid MCP JSON-RPC message.");
    if (typeof message.method === "string") {
      if (!Object.hasOwn(message, "id")) return;
      return message.method === "ping" ? { id: message.id, result: {} }
        : { id: message.id, error: { code: -32601, message: "Method not supported." } };
    }
    if (typeof message.id !== "number" || Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) {
      throw new Error("Invalid MCP JSON-RPC response.");
    }
    const waiting = pending.get(message.id);
    if (!waiting) return; // A cancelled or timed-out request can still receive its response.
    if ("error" in message) {
      if (!isRecord(message.error) || typeof message.error.code !== "number" || typeof message.error.message !== "string") {
        throw new Error("Invalid MCP JSON-RPC error.");
      }
      waiting.reject(Object.assign(new Error(message.error.message), { code: message.error.code, data: message.error.data }));
    } else {
      waiting.resolve(message.result);
    }
  }
  async function read() {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for await (const frame of frames(child.stdout)) {
      if (stopped) break;
      if (frame === null) throw new Error("MCP message exceeds the line size limit.");
      const line = decoder.decode(frame);
      if (!line.trim()) continue;
      const message: unknown = JSON.parse(line);
      if (Array.isArray(message)) {
        if (protocolVersion !== "2025-03-26" || !message.length || message.length > 64) throw new Error("Invalid MCP batch.");
        const replies = message.map(receive).filter(reply => reply !== undefined);
        if (replies.length) writeMessage(replies.map(reply => ({ jsonrpc: "2.0", ...reply })));
      } else {
        const reply = receive(message);
        if (reply) send(reply);
      }
    }
    stop(new Error("MCP server closed its output."));
  }
  child.once("error", stop);
  child.stdin.on("error", stop);
  signal?.addEventListener("abort", abortConnection, { once: true });
  void read().catch(error => stop(error instanceof Error ? error : new Error("MCP input failed.")));

  function request(method: string, params: object, requestSignal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      requestSignal?.throwIfAborted();
      if (stopped) throw stopped;
      if (pending.size >= 64) throw new Error("Too many pending MCP requests.");
      const id = ++nextId;
      function cleanup() {
        pending.delete(id);
        clearTimeout(timer);
        requestSignal?.removeEventListener("abort", abort);
      }
      function cancel(reason: unknown) {
        cleanup();
        reject(reason);
        if (method === "initialize") return;
        try {
          send({ method: "notifications/cancelled", params: { requestId: id } });
        } catch {
          // The request has already settled locally.
        }
      }
      function abort() { cancel(requestSignal?.reason); }
      const timer = setTimeout(() => cancel(new Error("MCP " + method + " timed out.")), timeoutMs);
      requestSignal?.addEventListener("abort", abort, { once: true });
      pending.set(id, {
        resolve(value) { cleanup(); resolve(value); },
        reject(error) { cleanup(); reject(error); },
      });
      try {
        send({ id, method, params });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  try {
    const init = await request("initialize", {
      protocolVersion: versions[0], capabilities: {}, clientInfo: { name: "agentic-task-kit", version: "1" },
    });
    if (!isRecord(init) || !versions.some(version => version === init.protocolVersion) || typeof init.protocolVersion !== "string") {
      throw new Error("Unsupported MCP protocol version.");
    }
    if (!isRecord(init.capabilities) || !isRecord(init.capabilities.tools)) throw new Error("MCP server lacks tools capability.");
    protocolVersion = init.protocolVersion;
    send({ method: "notifications/initialized" });
  } catch (error) {
    stop(new Error("MCP initialization failed."));
    await closed;
    throw error;
  }

  async function callTool(name: string, args: JsonObject = {}, opts: RequestOptions = {}): Promise<McpToolResult> {
    if (!hasText(name) || !isRecord(args)) throw new TypeError("MCP tool calls require a name and an arguments object.");
    const result = await request("tools/call", { name, arguments: args }, opts.signal);
    if (!isRecord(result) || !Array.isArray(result.content)
        || !result.content.every(item => isRecord(item) && hasText(item.type))
        || (result.structuredContent !== undefined && !isRecord(result.structuredContent))
        || (result.isError !== undefined && typeof result.isError !== "boolean")) {
      throw new Error("Invalid MCP tool result.");
    }
    const envelope = result as McpToolResult;
    if (envelope.isError) {
      const detail = toolValue(envelope);
      const message = isRecord(detail) && hasText(detail.message) ? detail.message : typeof detail === "string" ? detail : "MCP tool failed: " + name;
      const code = isRecord(detail) && typeof detail.code === "string" ? detail.code : "MCP_TOOL_ERROR";
      throw Object.assign(new Error(message), { code, result: envelope });
    }
    return envelope;
  }
  const callToolValue: McpClient["callToolValue"] = async (name, args, opts) => toolValue(await callTool(name, args, opts));
  return {
    protocolVersion, callTool, callToolValue,
    async listTools(opts = {}) {
      const tools: McpTool[] = [];
      const cursors = new Set<string>();
      const names = new Set<string>();
      let cursor: string | undefined;
      let totalBytes = 0;
      do {
        const page = await request("tools/list", cursor === undefined ? {} : { cursor }, opts.signal);
        if (!isRecord(page) || !Array.isArray(page.tools)) throw new Error("Invalid MCP tools list.");
        totalBytes += Buffer.byteLength(JSON.stringify(page));
        if (totalBytes > 16 * 1024 * 1024 || cursors.size >= 1024 || tools.length + page.tools.length > 16_384) {
          throw new Error("MCP tools list exceeds discovery limits.");
        }
        for (const tool of page.tools) {
          if (!isRecord(tool) || !hasText(tool.name) || !isRecord(tool.inputSchema) || names.has(tool.name)) {
            throw new Error("Invalid or duplicate MCP tool declaration.");
          }
          tools.push(tool as McpTool);
          names.add(tool.name);
        }
        if (page.nextCursor === undefined || page.nextCursor === null) return tools;
        if (!hasText(page.nextCursor) || page.nextCursor.length > 4096 || cursors.has(page.nextCursor)) {
          throw new Error("Invalid or repeated MCP tools cursor.");
        }
        cursors.add(page.nextCursor);
        cursor = page.nextCursor;
      } while (true);
    },
    readWorkflowArtifact: (runId, artifact, opts) => readArtifact(callToolValue, runId, artifact, opts),
    close() {
      stop(new Error("MCP client closed."));
      return closed;
    },
  };
}
