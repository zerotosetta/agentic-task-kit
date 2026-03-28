import {
  createCLIRenderer,
  createCycle,
  createOpenAICompatibleChatProviderFromConfigFile,
  createOpenAICompatibleChatProvider,
  loadOpenAICompatibleChatProviderOptionsFromConfigFile,
  OpenAISummaryWorkflow,
  OpenAIStreamingSummaryWorkflow,
  resolveOpenAICompatibleChatConfigPath,
  type CLIRendererOptions
} from "../src/index.js";

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

const renderer = createCLIRenderer(resolveRendererOptions());
const configPath = resolveOpenAICompatibleChatConfigPath();
const providerOptions = configPath
  ? loadOpenAICompatibleChatProviderOptionsFromConfigFile({
      configPath,
      overrides: {
        defaultModel: process.env.OPENAI_MODEL ?? "gpt-5.2"
      }
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
if (!providerOptions.apiKey) {
  process.stdout.write(
    `OpenAI-compatible API key is not configured. Set OPENAI_API_KEY or point CYCLE_OPENAI_COMPATIBLE_CONFIG_PATH or CYCLE_OPENAI_CONFIG_PATH to a config file.\n`
  );
  process.exit(0);
}

const aiProvider = configPath
  ? createOpenAICompatibleChatProviderFromConfigFile({
      configPath,
      overrides: {
        defaultModel: process.env.OPENAI_MODEL ?? "gpt-5.2"
      }
    })
  : createOpenAICompatibleChatProvider(providerOptions);

const useStreaming = process.env.CYCLE_STREAM === "1";
const requestHeaders = resolveRequestHeaders();

const cycle = createCycle({
  aiProvider,
  observers: [renderer]
});

cycle.register("openai-summary", OpenAISummaryWorkflow);
cycle.register("openai-streaming-summary", OpenAIStreamingSummaryWorkflow);

const { frame } = await cycle.run(useStreaming ? "openai-streaming-summary" : "openai-summary", {
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
