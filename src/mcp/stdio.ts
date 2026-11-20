import type { Readable, Writable } from "node:stream";
import { frames, versions } from "./framing.js";
import { normalizeFailure } from "../durable-errors.js";
import { isRecord } from "../durable-validation.js";

type RpcId = string | number;
type RpcResult = { jsonrpc: "2.0"; id: RpcId; result: unknown };
type RpcError = { jsonrpc: "2.0"; id: RpcId | null; error: { code: number; message: string } };
type RpcResponse = RpcResult | RpcError;

const batchVersion = "2025-03-26";
const maxConcurrentCalls = 64;
const maxBatchItems = 64;
const decoder = new TextDecoder("utf-8", { fatal: true });

const requiredString = { type: "string", minLength: 1 };

function tool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
  required: readonly string[],
  annotations: { readOnlyHint: boolean; idempotentHint?: boolean },
) {
  return {
    name,
    description,
    inputSchema: { type: "object" as const, properties, required, additionalProperties: false },
    annotations,
  };
}

export const workflowTools = [
  tool("workflow_list", "List the registered workflow profiles and revisions.", {}, [], { readOnlyHint: true }),
  tool("workflow_describe", "Discover the inputs, output and declared stage order of a workflow before starting it.", {
    profile: requiredString,
  }, ["profile"], { readOnlyHint: true }),
  tool("workflow_start", "Schedule a workflow and return its run ID. If the response was lost, repeat the same profile, request and idempotency key.", {
    profile: requiredString,
    request: { type: "object" },
    idempotencyKey: requiredString,
  }, ["profile", "request", "idempotencyKey"], { readOnlyHint: false, idempotentHint: true }),
  tool("workflow_status", "Poll the same run ID for its committed checkpoint, current work, progress, worker heartbeat and next action.", {
    runId: requiredString,
  }, ["runId"], { readOnlyHint: true }),
  tool("workflow_progress", "Read the current stage, its configured position, and the latest reported operation, item, counts and percentage for a run.", {
    runId: requiredString,
  }, ["runId"], { readOnlyHint: true }),
  tool("workflow_resume", "Schedule another invocation for an interrupted, cancelled, or failed run.", {
    runId: requiredString,
    expectedCheckpointSeq: { type: "integer", minimum: 0 },
    expectedInputSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
  }, ["runId"], { readOnlyHint: false }),
  tool("workflow_rerun", "Request a workflow-defined step rerun on the current checkpoint with an optional scope and parameters.", {
    runId: requiredString,
    expectedCheckpointSeq: { type: "integer", minimum: 0 },
    stepKey: { ...requiredString, maxLength: 256 },
    scope: { type: "object" },
    params: { type: "object" },
  }, ["runId", "expectedCheckpointSeq", "stepKey"], { readOnlyHint: false, idempotentHint: true }),
  tool("workflow_cancel", "Request cancellation of a workflow invocation.", {
    runId: requiredString,
  }, ["runId"], { readOnlyHint: false, idempotentHint: true }),
  tool("workflow_results", "List committed artifacts or read byte chunks of a selected artifact.", {
    runId: requiredString,
    artifactId: requiredString,
    cursor: requiredString,
    maxBytes: { type: "integer", minimum: 1 },
  }, ["runId"], { readOnlyHint: true }),
];

type ToolCall = (name: string, args: Record<string, unknown>, signal: AbortSignal) => unknown | Promise<unknown>;

function errorResponse(id: RpcId | null, code: number, message: string): RpcError {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function resultResponse(id: RpcId, result: unknown): RpcResult {
  return { jsonrpc: "2.0", id, result };
}

function isRpcId(value: unknown): value is RpcId {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));
}

function isRpcReply(message: Record<string, unknown>): boolean {
  return (isRpcId(message.id) || message.id === null)
    && (Object.hasOwn(message, "result") !== Object.hasOwn(message, "error"));
}

export function toolResult(data: object, legacy: boolean, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    ...(legacy ? {} : { structuredContent: data }),
    isError,
  };
}

export function toolError(error: unknown) {
  if (error instanceof Error || (isRecord(error) && typeof error.code === "string" && typeof error.message === "string")) {
    return normalizeFailure(error, "INTERNAL_ERROR", "Workflow request failed.");
  }
  return { code: "INTERNAL_ERROR", message: "Workflow request failed." };
}

/** Serve newline-delimited MCP messages. A request's controller is separate from any workflow controller. */
export async function serveMcpStdio(
  call: ToolCall,
  { input = process.stdin, output = process.stdout, serverName = "atk-mcp", serverVersion = "dev", tools = workflowTools }: {
    input?: Readable;
    output?: Writable;
    serverName?: string;
    serverVersion?: string;
    tools?: readonly { name: string; description: string; inputSchema: object }[];
  } = {},
): Promise<void> {
  const active = new Map<RpcId, AbortController>();
  const pending = new Set<Promise<void>>();
  let phase: "new" | "initialized" | "ready" = "new";
  let protocolVersion: typeof versions[number] | undefined;
  let outputError: Error | undefined;
  let latestWrite = Promise.resolve();

  function send(response: RpcResponse | RpcResponse[]) {
    if (outputError || output.destroyed || output.writableEnded) return;
    const line = JSON.stringify(response) + "\n";
    latestWrite = new Promise<void>(resolve => {
      output.write(line, () => resolve());
    });
  }

  function handleNotification(method: string, params: Record<string, unknown> | undefined): void {
    if (method === "notifications/initialized" && phase === "initialized") phase = "ready";
    if (method === "notifications/cancelled" && isRpcId(params?.requestId)) {
      const reason = typeof params.reason === "string" ? params.reason : "MCP request cancelled.";
      active.get(params.requestId)?.abort(new Error(reason));
    }
  }

  async function handle(message: unknown): Promise<RpcResponse | undefined> {
    if (!isRecord(message) || message.jsonrpc !== "2.0") {
      return errorResponse(null, -32600, "Invalid JSON-RPC request.");
    }
    if (typeof message.method !== "string" || !message.method) {
      return isRpcReply(message) ? undefined : errorResponse(null, -32600, "Invalid JSON-RPC request.");
    }
    const { method, id, params } = message;
    if (!Object.hasOwn(message, "id")) {
      if (params === undefined || isRecord(params)) handleNotification(method, params);
      return undefined;
    }
    if (!isRpcId(id)) return errorResponse(null, -32600, "Invalid JSON-RPC request ID.");
    if (params !== undefined && !isRecord(params)) return errorResponse(id, -32602, "Parameters must be an object.");
    if (active.has(id)) return errorResponse(id, -32600, "Request ID is already in use.");
    if (method === "ping") return resultResponse(id, {});
    if (method === "initialize") {
      if (phase !== "new") return errorResponse(id, -32600, "MCP is already initialized.");
      if (typeof params?.protocolVersion !== "string" || !isRecord(params.capabilities)
        || !isRecord(params.clientInfo) || typeof params.clientInfo.name !== "string"
        || typeof params.clientInfo.version !== "string") {
        return errorResponse(id, -32602, "Initialize requires protocolVersion, capabilities, and clientInfo.");
      }
      protocolVersion = versions.find(version => version === params.protocolVersion) ?? versions[0];
      phase = "initialized";
      return resultResponse(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: serverName, version: serverVersion },
      });
    }
    if (phase !== "ready") return errorResponse(id, -32002, "MCP initialization is required.");
    if (method === "tools/list") return resultResponse(id, { tools });
    if (method !== "tools/call") return errorResponse(id, -32601, "Method not found.");
    const name = params?.name;
    const args = params?.arguments;
    if (typeof name !== "string" || (args !== undefined && !isRecord(args))) {
      return errorResponse(id, -32602, "Tool calls require a name and an arguments object.");
    }
    if (!tools.some(candidate => candidate.name === name)) {
      return errorResponse(id, -32602, "Unknown tool.");
    }
    if (active.size >= maxConcurrentCalls) return errorResponse(id, -32000, "Too many pending tool calls.");
    const controller = new AbortController();
    active.set(id, controller);
    const legacy = protocolVersion === batchVersion;
    try {
      const data = await call(name, args ?? {}, controller.signal);
      if (controller.signal.aborted) return undefined;
      if (!isRecord(data)) throw new Error("Workflow response must be a JSON object.");
      return resultResponse(id, toolResult(data, legacy));
    } catch (error) {
      return controller.signal.aborted ? undefined : resultResponse(id, toolResult(toolError(error), legacy, true));
    } finally {
      active.delete(id);
    }
  }

  async function dispatch(message: unknown): Promise<void> {
    if (Array.isArray(message)) {
      // The March 2025 revision used batches. Later revisions require one message per line.
      if (protocolVersion !== batchVersion || message.length === 0 || message.length > maxBatchItems) {
        send(errorResponse(null, -32600, "Invalid or unsupported JSON-RPC batch."));
        return;
      }
      const responses = (await Promise.all(message.map(handle))).filter(
        (response): response is RpcResponse => response !== undefined,
      );
      if (responses.length) send(responses);
    } else {
      const response = await handle(message);
      if (response) send(response);
    }
  }

  function outputFailed(error: Error): void {
    outputError = error;
    for (const controller of active.values()) controller.abort(error);
    input.destroy();
  }

  output.on("error", outputFailed);
  try {
    for await (const frame of frames(input)) {
      if (output.writableNeedDrain) await latestWrite;
      if (frame === null) {
        send(errorResponse(null, -32700, "MCP input exceeds the line size limit."));
      } else {
        let message: unknown;
        try {
          const line = decoder.decode(frame);
          if (!line.trim()) continue;
          message = JSON.parse(line) as unknown;
        } catch {
          send(errorResponse(null, -32700, "Invalid JSON in MCP input."));
          continue;
        }
        const task = dispatch(message).catch(() => {
          send(errorResponse(null, -32603, "MCP response could not be encoded."));
        });
        pending.add(task);
        void task.finally(() => pending.delete(task));
      }
    }
  } catch (error) {
    for (const controller of active.values()) controller.abort(error);
    // The client can close its input pipe without waiting for this server's final write.
    if (!outputError || (outputError as NodeJS.ErrnoException).code !== "EPIPE") throw error;
  } finally {
    await Promise.allSettled(pending);
    await latestWrite;
    output.off("error", outputFailed);
  }
  if (outputError && (outputError as NodeJS.ErrnoException).code !== "EPIPE") throw outputError;
}
