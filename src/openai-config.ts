import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { createOpenAIChatProvider } from "./openai-provider.js";
import type {
  AIProvider,
  OpenAIChatProviderConfigFileOptions,
  OpenAIChatProviderFileConfig,
  OpenAIChatProviderOptions
} from "./types.js";

type OpenAIConfigDocument = OpenAIChatProviderFileConfig & {
  openai?: OpenAIChatProviderFileConfig;
};

function resolveConfigPath(configPath?: string): string | null {
  const rawPath =
    configPath ??
    process.env.CYCLE_OPENAI_CONFIG_PATH ??
    process.env.OPENAI_CONFIG_PATH;

  if (!rawPath) {
    return null;
  }

  return isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
}

function parseConfigDocument(configPath: string): OpenAIConfigDocument {
  const content = readFileSync(configPath, "utf8");
  const parsed = JSON.parse(content) as OpenAIConfigDocument;
  return parsed;
}

function resolveOptionValue(
  directValue: string | undefined,
  envName: string | undefined
): string | undefined {
  if (directValue !== undefined) {
    return directValue;
  }

  if (!envName) {
    return undefined;
  }

  return process.env[envName];
}

function toProviderOptions(
  config: OpenAIChatProviderFileConfig
): OpenAIChatProviderOptions {
  const options: OpenAIChatProviderOptions = {};

  const apiKey = resolveOptionValue(config.apiKey, config.apiKeyEnv);
  const baseURL = resolveOptionValue(config.baseURL, config.baseURLEnv);
  const organization = resolveOptionValue(config.organization, config.organizationEnv);
  const project = resolveOptionValue(config.project, config.projectEnv);

  if (apiKey !== undefined) {
    options.apiKey = apiKey;
  }

  if (baseURL !== undefined) {
    options.baseURL = baseURL;
  }

  if (organization !== undefined) {
    options.organization = organization;
  }

  if (project !== undefined) {
    options.project = project;
  }

  if (config.defaultModel !== undefined) {
    options.defaultModel = config.defaultModel;
  }

  if (config.timeoutMs !== undefined) {
    options.timeoutMs = config.timeoutMs;
  }

  if (config.maxRetries !== undefined) {
    options.maxRetries = config.maxRetries;
  }

  if (config.defaultTemperature !== undefined) {
    options.defaultTemperature = config.defaultTemperature;
  }

  if (config.defaultMaxCompletionTokens !== undefined) {
    options.defaultMaxCompletionTokens = config.defaultMaxCompletionTokens;
  }

  if (config.defaultReasoningEffort !== undefined) {
    options.defaultReasoningEffort = config.defaultReasoningEffort;
  }

  return options;
}

export function loadOpenAIChatProviderOptionsFromConfigFile(
  options: OpenAIChatProviderConfigFileOptions = {}
): OpenAIChatProviderOptions {
  const resolvedPath = resolveConfigPath(options.configPath);
  let fileOptions: OpenAIChatProviderOptions = {};

  if (resolvedPath) {
    const parsed = parseConfigDocument(resolvedPath);
    fileOptions = toProviderOptions(parsed.openai ?? parsed);
  }

  return {
    ...fileOptions,
    ...options.overrides
  };
}

export function resolveOpenAIChatConfigPath(configPath?: string): string | null {
  return resolveConfigPath(configPath);
}

export function createOpenAIChatProviderFromConfigFile(
  options?: OpenAIChatProviderConfigFileOptions
): AIProvider {
  return createOpenAIChatProvider(loadOpenAIChatProviderOptionsFromConfigFile(options));
}
