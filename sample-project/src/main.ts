import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCLIRenderer,
  createCycle,
  createOpenAIChatProviderFromConfigFile,
  loadOpenAIChatProviderOptionsFromConfigFile,
  OpenAISummaryWorkflow,
  resolveOpenAIChatConfigPath,
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

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const defaultConfigPath = resolve(currentDir, "..", "cycle.config.json");
const configPath =
  resolveOpenAIChatConfigPath(process.env.CYCLE_OPENAI_CONFIG_PATH) ?? defaultConfigPath;
const providerOptions = loadOpenAIChatProviderOptionsFromConfigFile({
  configPath
});

if (!providerOptions.apiKey) {
  process.stdout.write(
    `OpenAI API key is not configured. Set OPENAI_API_KEY or put apiKey in ${configPath}.\n`
  );
  process.exit(0);
}

const renderer = createCLIRenderer(resolveRendererOptions());
const cycle = createCycle({
  aiProvider: createOpenAIChatProviderFromConfigFile({
    configPath
  }),
  observers: [renderer]
});

cycle.register("openai-summary", OpenAISummaryWorkflow);

const { frame } = await cycle.run("openai-summary", {
  product: "Cycle",
  objective: "Summarize OpenAI configuration file support for a sample host application.",
  configPath
});

process.stdout.write(
  `Sample project finished with status=${frame.status} completedTasks=${frame.completedTasks.join(",")}\n`
);
