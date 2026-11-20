import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isRecord } from "../durable-validation.js";
import { versions, maxFrameBytes } from "../mcp/framing.js";
import { toolError, toolResult } from "../mcp/stdio.js";
import { dashboardHtml, dashboardScript, dashboardStyles } from "./dashboard.js";

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function json(res: ServerResponse, status: number, data: unknown) {
  const serialized = JSON.stringify(data);
  if (Buffer.byteLength(serialized) > 16 * maxFrameBytes)
    throw new HttpError(500, "RESPONSE_TOO_LARGE", "Response exceeds 16 MiB. Request a smaller page or chunk.");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(serialized);
}

async function callTool(tools: Tools, name: string, args: Record<string, unknown>, signal: AbortSignal) {
  signal.throwIfAborted();
  let cancel!: () => void;
  const deadline = new Promise<never>((_, reject) => {
    cancel = () => reject(new HttpError(503, "REQUEST_INTERRUPTED", "Request timed out or service is shutting down."));
    signal.addEventListener("abort", cancel, { once: true });
  });
  try { return await Promise.race([tools.call(name, args, signal), deadline]); }
  finally { signal.removeEventListener("abort", cancel); }
}

async function body(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json")
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Send application/json.");
  const tooLarge = () => new HttpError(413, "PAYLOAD_TOO_LARGE", "Request exceeds the 8 MiB limit.");
  if (Number(req.headers["content-length"]) > 8 * maxFrameBytes) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 8 * maxFrameBytes) throw tooLarge();
    chunks.push(chunk);
  }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))) as unknown; }
  catch { throw new HttpError(400, "INVALID_JSON", "Expected a UTF-8 JSON document."); }
}

interface Tools {
  listTools(): readonly { name: string; description: string; inputSchema: object }[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
}
async function rpc(res: ServerResponse, value: unknown, tools: Tools, signal: AbortSignal, version: string) {
  const invalid = (id: unknown, code: number, message: string, status = 200) =>
    json(res, status, { jsonrpc: "2.0", id, error: { code, message } });
  if (!isRecord(value) || value.jsonrpc !== "2.0" || "result" in value || "error" in value ||
      typeof value.method !== "string" || !value.method)
    return invalid(null, -32600, "Expected a single JSON-RPC request or notification.", 400);
  const { id, method, params = {} } = value;
  if (id === undefined && method.startsWith("notifications/") && isRecord(params)) {
    res.writeHead(202).end();
    return;
  }
  if (typeof id !== "string" && !Number.isSafeInteger(id)) return invalid(null, -32600, "Invalid request ID.", 400);
  if (!isRecord(params)) return invalid(id, -32602, "Expected a parameter object.");
  const result = (data: unknown) => json(res, 200, { jsonrpc: "2.0", id, result: data });
  switch (method) {
    case "initialize":
      if (typeof params.protocolVersion !== "string" || !isRecord(params.capabilities) || !isRecord(params.clientInfo)
        || typeof params.clientInfo.name !== "string" || typeof params.clientInfo.version !== "string")
        return invalid(id, -32602, "Expected protocolVersion, capabilities and clientInfo.");
      return result({ protocolVersion: versions.find(v => v === params.protocolVersion && v !== "2025-03-26") ?? versions[0],
        capabilities: { tools: {} }, serverInfo: { name: "atk-mcp", version } });
    case "ping": return result({});
    case "tools/list": return result({ tools: tools.listTools() });
    case "tools/call": {
      const args = params.arguments === undefined ? {} : params.arguments;
      if (!isRecord(args) || typeof params.name !== "string" || !tools.listTools().some(t => t.name === params.name))
        return invalid(id, -32602, "Expected a registered tool name and an arguments object.");
      try {
        const data = await callTool(tools, params.name, args, signal);
        return result(isRecord(data) ? toolResult(data, false) : { content: [{ type: "text", text: JSON.stringify(data) }] });
      } catch (error) {
        return result(toolResult(toolError(error), false, true));
      }
    }
    default: return invalid(id, -32601, "Unknown method.");
  }
}

const assets = new Map([
  ["/app.js", ["text/javascript", dashboardScript]],
  ["/app.css", ["text/css", dashboardStyles]],
]);
const digest = (text: string) => createHash("sha256").update(text).digest();
function authority(host: string, port: number) {
  return new URL("http://" + (host.includes(":") ? "[" + host + "]" : host) + ":" + port).host;
}

export async function startSessionHttp(tools: Tools, options: {
  host: string; port: number; token: string; origin?: string; version: string;
}) {
  const { host, port, token, version } = options;
  if (!token || !/^[\x21-\x7e]+$/.test(token)) throw new Error("Set ATK_SERVICE_TOKEN to a nonempty visible ASCII token.");
  const external = options.origin === undefined ? undefined : new URL(options.origin);
  if (external && (!["http:", "https:"].includes(external.protocol) || external.origin !== options.origin))
    throw new Error("ATK_SERVICE_ORIGIN must be an exact HTTP(S) origin, without a trailing slash.");
  const expected = digest(token);
  const closing = new AbortController();
  const server = createServer({ headersTimeout: 10_000, requestTimeout: 30_000, connectionsCheckingInterval: 1000 }, async (req, res) => {
    const path = req.url?.split("?")[0] ?? "";
    const mcp = path === "/mcp";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    try {
      const actualPort = req.socket.localPort!;
      const allowedHosts = new Set([authority(host, actualPort)]);
      if (req.socket.localAddress) allowedHosts.add(authority(req.socket.localAddress, actualPort));
      if (["127.0.0.1", "localhost", "::1"].includes(host)) allowedHosts.add(authority("localhost", actualPort));
      if (external) allowedHosts.add(external.host);
      const incomingHost = req.headers.host?.toLowerCase();
      if (!incomingHost || !allowedHosts.has(incomingHost) || (req.headers.origin !== undefined &&
          req.headers.origin !== (external ? external.origin : "http://" + incomingHost)) ||
          req.headers["sec-fetch-site"] === "cross-site")
        throw new HttpError(403, "FORBIDDEN", "Host or origin is not allowed.");
      const page = path === "/" || /^\/app(?:\/sessions\/[A-Za-z0-9_-]+)?\/?$/.test(path);
      const asset = page ? ["text/html", dashboardHtml] : assets.get(path);
      const name = /^\/api\/tools\/([A-Za-z0-9_-]+)$/.exec(path)?.[1];
      if (!asset && !mcp && !name) throw new HttpError(404, "NOT_FOUND", "Unknown endpoint.");
      if (!asset) {
        const credential = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "")?.[1];
        if (!credential || !timingSafeEqual(digest(credential), expected)) {
          res.setHeader("WWW-Authenticate", 'Bearer realm="atk"');
          throw new HttpError(401, "UNAUTHORIZED", "A valid bearer token is required.");
        }
      }
      if (req.method !== (asset ? "GET" : "POST")) {
        res.setHeader("Allow", asset ? "GET" : "POST");
        throw new HttpError(405, "METHOD_NOT_ALLOWED", "Unsupported HTTP method.");
      }
      if (asset) {
        res.writeHead(200, { "Content-Type": asset[0] + "; charset=utf-8" }).end(asset[1]);
        return;
      }
      if (mcp) {
        const accept = (req.headers.accept ?? "").toLowerCase().split(",").filter(part => !/;\s*q=0(?:\.0*)?\s*(?:;|$)/.test(part))
          .map(part => part.split(";")[0]?.trim());
        if (!accept.includes("application/json") || !accept.includes("text/event-stream"))
          throw new HttpError(406, "NOT_ACCEPTABLE", "Accept application/json and text/event-stream.");
        const revision = req.headers["mcp-protocol-version"];
        if (revision !== undefined && revision !== versions[0] && revision !== "2025-06-18")
          throw new HttpError(400, "UNSUPPORTED_VERSION", "Unsupported MCP protocol version.");
      }
      const input = await body(req);
      const timeout = AbortSignal.timeout(30_000);
      const signal = AbortSignal.any([timeout, closing.signal]);
      if (mcp) return await rpc(res, input, tools, signal, version);
      if (!name || !tools.listTools().some(t => t.name === name)) throw new HttpError(404, "UNKNOWN_TOOL", "Unknown tool.");
      if (!isRecord(input)) throw new HttpError(400, "INVALID_ARGUMENT", "Tool arguments must be an object.");
      json(res, 200, await callTool(tools, name, input, signal));
    } catch (error) {
      if (res.destroyed || res.headersSent) return;
      const { code, message } = toolError(error);
      const detail = { code, message };
      const status = error instanceof HttpError ? error.status : detail.code.endsWith("NOT_FOUND") ? 404 :
        /CONFLICT|STALE|ALREADY|MISMATCH/.test(detail.code) ? 409 : detail.code === "INTERNAL_ERROR" ? 500 : 400;
      if (!req.complete) req.resume();
      if (mcp) json(res, status, { jsonrpc: "2.0", id: null, error: { code: detail.code === "INVALID_JSON" ? -32700 : -32000, message: detail.message } });
      else json(res, status, { error: detail });
    }
  });
  server.maxConnections = 128;
  server.setTimeout(60_000);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected a TCP listener.");
  return { port: address.port, close: async () => {
    closing.abort();
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      const timer = setTimeout(() => server.closeAllConnections(), 1_000).unref();
      server.once("close", () => clearTimeout(timer));
    });
  } };
}
