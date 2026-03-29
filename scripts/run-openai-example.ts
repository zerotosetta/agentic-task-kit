import { PassThrough } from "node:stream";

import {
  createCLIRenderer,
  createCycle,
  createOpenAICompatibleChatProvider,
  loadOpenAICompatibleChatProviderOptionsFromConfigFile,
  OpenAISummaryWorkflow,
  resolveOpenAICompatibleChatConfigPath,
  type CLIRendererOptions
} from "../src/index.js";

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

const rendererOptions = resolveRendererOptions();
const debugLogStream = rendererOptions.mode === "ink" ? new PassThrough() : undefined;
const renderer = createCLIRenderer({
  ...rendererOptions,
  ...(debugLogStream ? { debugLogStream } : {})
});
const configPath = resolveOpenAICompatibleChatConfigPath();
const loadedProviderOptions = configPath
  ? loadOpenAICompatibleChatProviderOptionsFromConfigFile({
      configPath,
      ...(process.env.OPENAI_MODEL
        ? {
            overrides: {
              defaultModel: process.env.OPENAI_MODEL
            }
          }
        : {})
    })
  : {
      defaultModel: process.env.OPENAI_MODEL ?? "gpt-5.2",
      ...(process.env.OPENAI_TIMEOUT_MS
        ? {
            timeoutMs: Number.parseInt(process.env.OPENAI_TIMEOUT_MS, 10)
          }
        : {}),
      ...(process.env.OPENAI_MAX_RETRIES
        ? {
            maxRetries: Number.parseInt(process.env.OPENAI_MAX_RETRIES, 10)
          }
        : {})
    };
const providerOptions = withDebugStream(loadedProviderOptions, debugLogStream);
if (!providerOptions.apiKey) {
  process.stdout.write(
    `OpenAI-compatible API key is not configured. Set OPENAI_API_KEY or point CYCLE_OPENAI_COMPATIBLE_CONFIG_PATH or CYCLE_OPENAI_CONFIG_PATH to a config file.\n`
  );
  process.exit(0);
}

const aiProvider = createOpenAICompatibleChatProvider(providerOptions);

const requestHeaders = resolveRequestHeaders();

const cycle = createCycle({
  aiProvider,
  observers: [renderer]
});

cycle.register("openai-summary", OpenAISummaryWorkflow);

const { frame } = await cycle.run("openai-summary", {
  objective: "Summarize the current MVP rollout status for the first customer pilot.",
  constraints: [
    "Keep the workflow sequential",
    "Report CLI renderer support",
    "Mention provider config support"
  ],
  ...(requestHeaders ? { requestHeaders } : {})
});

process.stdout.write(
  `OpenAI-compatible example finished with status=${frame.status} completedTasks=${frame.completedTasks.join(",")}\n`
);
