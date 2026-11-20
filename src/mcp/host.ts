import { fileURLToPath } from "node:url";
import { isRecord } from "../durable-validation.js";
import { assertPipelineSchema, assertPipelineValue, type PipelineSchema } from "../pipeline-schema.js";
import type { DurableJSON } from "../types/durable.js";
import { loadMcpConfig } from "./config.js";
import { McpWorkflowService } from "./service.js";
import { serveMcpStdio, toolError, toolResult, workflowTools } from "./stdio.js";

export interface McpJsonTool {
  name: string;
  description: string;
  inputSchema: PipelineSchema;
  outputSchema?: PipelineSchema;
  run(input: Readonly<Record<string, DurableJSON>>, signal: AbortSignal): DurableJSON | Promise<DurableJSON>;
}

/** Serve schema-checked JSON tools from a standalone Node stdio process. */
export async function serveMcpTools(tools: readonly McpJsonTool[], options: { name: string; version: string }) {
  const byName = new Map<string, McpJsonTool>();
  const definitions = tools.map(({ run, ...descriptor }) => {
    if (!/^[A-Za-z0-9_.-]{1,128}$/u.test(descriptor.name) || byName.has(descriptor.name)) {
      throw new TypeError("Invalid or duplicate MCP tool name: " + descriptor.name);
    }
    assertPipelineSchema(descriptor.inputSchema);
    if (descriptor.outputSchema !== undefined) assertPipelineSchema(descriptor.outputSchema);
    if (descriptor.inputSchema.type !== "object" || (descriptor.outputSchema && descriptor.outputSchema.type !== "object")) {
      throw new TypeError("MCP tools require object input and output schemas.");
    }
    byName.set(descriptor.name, { ...descriptor, run });
    return descriptor;
  });
  await serveMcpStdio(async (name, input, signal) => {
    const tool = byName.get(name)!;
    assertPipelineValue(tool.inputSchema, input, "arguments");
    const value = await tool.run(input as Record<string, DurableJSON>, signal);
    assertPipelineValue(tool.outputSchema ?? { type: "object" }, value, "result");
    return value;
  }, { serverName: options.name, serverVersion: options.version, tools: definitions });
}

/** Attach these tool definitions and handlers to an existing MCP server's discovery and call handlers. */
export function openWorkflowTools(configPath: string, options: { workerEntry?: string } = {}) {
  // The package entry and detached worker CLI are siblings in the published dist directory.
  const entry = options.workerEntry ?? fileURLToPath(new URL("./atk-mcp.js", import.meta.url));
  const service = new McpWorkflowService(loadMcpConfig(configPath), entry);
  return {
    listTools: () => structuredClone(workflowTools),
    async callTool(name: string, args: Record<string, unknown>, signal = new AbortController().signal) {
      try {
        const result = await service.call(name, args, signal);
        if (!isRecord(result)) throw new Error("Expected a workflow tool result.");
        return toolResult(result, false);
      } catch (error) {
        signal.throwIfAborted();
        return toolResult(toolError(error), false, true);
      }
    },
    close: () => service.close(),
  };
}
