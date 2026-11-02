import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  resolveRendererOptions,
  resolveRequestHeaders,
  withDebugStream,
} from "./sample-runtime.js";

import {
  createCLIRenderer,
  createCycle,
  createOpenAICompatibleChatProvider,
  createWorkflowInput,
  loadOpenAICompatibleChatProviderOptionsFromConfigFile,
  OpenAIStreamingSummaryWorkflow,
  resolveOpenAICompatibleChatConfigPath,
} from "agentic-task-kit";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const defaultConfigPath = resolve(currentDir, "..", "cycle.config.json");
const configPath =
  resolveOpenAICompatibleChatConfigPath(process.env.CYCLE_OPENAI_CONFIG_PATH) ?? defaultConfigPath;
const providerOptions = loadOpenAICompatibleChatProviderOptionsFromConfigFile({
  configPath,
});

if (!providerOptions.apiKey) {
  process.stdout.write(
    `OpenAI-compatible API key is not configured. Set OPENAI_API_KEY or put apiKey in ${configPath}.\n`,
  );
  process.exit(0);
}

const rendererOptions = resolveRendererOptions();
const debugLogStream = rendererOptions.mode === "ink" ? new PassThrough() : undefined;
const renderer = createCLIRenderer({
  ...rendererOptions,
  ...(debugLogStream ? { debugLogStream } : {}),
});
const requestHeaders = resolveRequestHeaders();
const cycle = createCycle({
  aiProvider: createOpenAICompatibleChatProvider(withDebugStream(providerOptions, debugLogStream)),
  observers: [renderer],
});

cycle.register("openai-streaming-summary", OpenAIStreamingSummaryWorkflow);

const { frame } = await cycle.run(
  "openai-streaming-summary",
  createWorkflowInput({
    product: "Cycle",
    objective: "Summarize OpenAI-compatible configuration support for a sample host application.",
    configPath,
    ...(requestHeaders ? { requestHeaders } : {}),
  }),
);

process.stdout.write(
  `Sample streaming project finished with status=${frame.status} completedTasks=${frame.completedTasks.join(",")}\n`,
);
