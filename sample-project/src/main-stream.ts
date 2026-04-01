import { PassThrough } from "node:stream";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCLIRenderer,
  createCycle,
  createOpenAICompatibleChatProvider,
  createWorkflowInput,
  loadOpenAICompatibleChatProviderOptionsFromConfigFile,
  OpenAIStreamingSummaryWorkflow,
  resolveOpenAICompatibleChatConfigPath,
  type CLIRendererOptions
} from "agentic-task-kit";

function resolveRendererOptions(): CLIRendererOptions {
  const requestedMode = process.env.CYCLE_RENDER_MODE as CLIRendererOptions["mode"];
  const requestedLogLevel = process.env.CYCLE_LOG_LEVEL as CLIRendererOptions["logLevel"];

  if (requestedMode) {
    return {
      enabled: process.env.CYCLE_LIVE !== "0",
      mode: requestedMode,
      ...(requestedLogLevel ? { logLevel: requestedLogLevel } : {})
    };
  }

  return {
    enabled: process.env.CYCLE_LIVE !== "0",
    ...(requestedLogLevel ? { logLevel: requestedLogLevel } : {})
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

function resolveHTTPDebugEnabled(
  value: boolean | Record<string, unknown> | undefined
): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const enabled = value["enabled"];
    return typeof enabled === "boolean" ? enabled : true;
  }

  return ["1", "true", "yes", "on"].includes((process.env.OPENAI_HTTP_DEBUG ?? "").toLowerCase());
}

function withDebugStream<T extends { httpDebugLogging?: boolean | Record<string, unknown> }>(
  options: T,
  debugLogStream: PassThrough | undefined
): T {
  if (!debugLogStream || !resolveHTTPDebugEnabled(options.httpDebugLogging)) {
    return options;
  }

  const current = options.httpDebugLogging;
  return {
    ...options,
    httpDebugLogging:
      current && typeof current === "object" && !Array.isArray(current)
        ? {
            ...current,
            stream: debugLogStream
          }
        : {
            enabled: true,
            stream: debugLogStream
          }
  };
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

const rendererOptions = resolveRendererOptions();
const debugLogStream = rendererOptions.mode === "ink" ? new PassThrough() : undefined;
const renderer = createCLIRenderer({
  ...rendererOptions,
  ...(debugLogStream ? { debugLogStream } : {})
});
const requestHeaders = resolveRequestHeaders();
const cycle = createCycle({
  aiProvider: createOpenAICompatibleChatProvider(withDebugStream(providerOptions, debugLogStream)),
  observers: [renderer]
});

cycle.register("openai-streaming-summary", OpenAIStreamingSummaryWorkflow);

const { frame } = await cycle.run(
  "openai-streaming-summary",
  createWorkflowInput({
    product: "Cycle",
    objective: "Summarize OpenAI-compatible configuration support for a sample host application.",
    configPath,
    ...(requestHeaders ? { requestHeaders } : {})
  })
);

process.stdout.write(
  `Sample streaming project finished with status=${frame.status} completedTasks=${frame.completedTasks.join(",")}\n`
);
