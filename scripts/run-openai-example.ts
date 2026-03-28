import {
  createCLIRenderer,
  createCycle,
  createOpenAIChatProviderFromConfigFile,
  createOpenAIChatProvider,
  loadOpenAIChatProviderOptionsFromConfigFile,
  OpenAISummaryWorkflow,
  resolveOpenAIChatConfigPath,
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

const renderer = createCLIRenderer(resolveRendererOptions());
const configPath = resolveOpenAIChatConfigPath();
const providerOptions = configPath
  ? loadOpenAIChatProviderOptionsFromConfigFile({
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
    `OpenAI API key is not configured. Set OPENAI_API_KEY or point CYCLE_OPENAI_CONFIG_PATH to a config file.\n`
  );
  process.exit(0);
}

const aiProvider = configPath
  ? createOpenAIChatProviderFromConfigFile({
      configPath,
      overrides: {
        defaultModel: process.env.OPENAI_MODEL ?? "gpt-5.2"
      }
    })
  : createOpenAIChatProvider(providerOptions);

const cycle = createCycle({
  aiProvider,
  observers: [renderer]
});

cycle.register("openai-summary", OpenAISummaryWorkflow);

const { frame } = await cycle.run("openai-summary", {
  objective: "Summarize the current MVP rollout status for the first customer pilot.",
  constraints: ["Keep the workflow sequential", "Report CLI renderer support", "Mention provider config support"]
});

process.stdout.write(
  `OpenAI example finished with status=${frame.status} completedTasks=${frame.completedTasks.join(",")}\n`
);
