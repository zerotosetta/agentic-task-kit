import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCLIRenderer,
  createCycle,
  createOpenAICompatibleChatProviderFromConfigFile,
  loadOpenAICompatibleChatProviderOptionsFromConfigFile,
  OpenAISummaryWorkflow,
  OpenAIStreamingSummaryWorkflow,
  resolveOpenAICompatibleChatConfigPath,
  type CLIRendererOptions
} from "agentic-task-kit";

function resolveRendererOptions(): CLIRendererOptions {
  const requestedMode = process.env.CYCLE_RENDER_MODE as CLIRendererOptions["mode"];

  if (requestedMode) {
    return {
      enabled: process.env.CYCLE_LIVE !== "0",
      mode: requestedMode
    };
  }

  return {
    enabled: process.env.CYCLE_LIVE !== "0"
  };
}

function resolveRequestHeaders(): Record<string, string> | undefined {
  if (!process.env.CYCLE_REQUEST_HEADERS_JSON) {
    return undefined;
  }

  const parsed = JSON.parse(process.env.CYCLE_REQUEST_HEADERS_JSON) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CYCLE_REQUEST_HEADERS_JSON must be a JSON object.");
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const defaultConfigPath = resolve(currentDir, "..", "cycle.config.json");
const configPath =
  resolveOpenAICompatibleChatConfigPath(process.env.CYCLE_OPENAI_CONFIG_PATH) ?? defaultConfigPath;
const providerOptions = loadOpenAICompatibleChatProviderOptionsFromConfigFile({
  configPath
});

if (!providerOptions.apiKey) {
  process.stdout.write(
    `OpenAI-compatible API key is not configured. Set OPENAI_API_KEY or put apiKey in ${configPath}.\n`
  );
  process.exit(0);
}

const renderer = createCLIRenderer(resolveRendererOptions());
const useStreaming = process.env.CYCLE_STREAM === "1";
const requestHeaders = resolveRequestHeaders();
const cycle = createCycle({
  aiProvider: createOpenAICompatibleChatProviderFromConfigFile({
    configPath
  }),
  observers: [renderer]
});

cycle.register("openai-summary", OpenAISummaryWorkflow);
cycle.register("openai-streaming-summary", OpenAIStreamingSummaryWorkflow);

const { frame } = await cycle.run(useStreaming ? "openai-streaming-summary" : "openai-summary", {
  product: "Cycle",
  objective: "Summarize OpenAI-compatible configuration support for a sample host application.",
  configPath,
  ...(requestHeaders ? { requestHeaders } : {})
});

process.stdout.write(
  `Sample project finished with status=${frame.status} completedTasks=${frame.completedTasks.join(",")} stream=${useStreaming ? "on" : "off"}\n`
);
