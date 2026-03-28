import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

import { createOpenAICompatibleChatProvider, createOpenAIChatProvider } from "./openai-provider.js";
import type {
  AIProvider,
  OpenAIChatProviderConfigFileOptions,
  OpenAIChatProviderFileConfig,
  OpenAIChatProviderOptions,
  OpenAICompatibleChatProviderConfigFileOptions,
  OpenAICompatibleChatProviderFileConfig,
  OpenAICompatibleChatProviderOptions
} from "./types.js";

type OpenAICompatibleConfigDocument = OpenAICompatibleChatProviderFileConfig & {
  openai?: OpenAIChatProviderFileConfig;
  openaiCompatible?: OpenAICompatibleChatProviderFileConfig;
};

function resolveConfigPath(configPath?: string): string | null {
  const rawPath =
    configPath ??
    process.env.CYCLE_OPENAI_COMPATIBLE_CONFIG_PATH ??
    process.env.CYCLE_OPENAI_CONFIG_PATH ??
    process.env.OPENAI_CONFIG_PATH;

  if (!rawPath) {
    return null;
  }

  return isAbsolute(rawPath) ? rawPath : resolve(process.cwd(), rawPath);
}

function parseConfigDocument(configPath: string): OpenAICompatibleConfigDocument {
  const content = readFileSync(configPath, "utf8");
  return JSON.parse(content) as OpenAICompatibleConfigDocument;
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
  config: OpenAICompatibleChatProviderFileConfig
): OpenAICompatibleChatProviderOptions {
  const options: OpenAICompatibleChatProviderOptions = {};

  const apiKey = resolveOptionValue(config.apiKey, config.apiKeyEnv);
  const baseURL = resolveOptionValue(config.baseURL, config.baseURLEnv);
  const organization = resolveOptionValue(config.organization, config.organizationEnv);
  const project = resolveOptionValue(config.project, config.projectEnv);

  if (config.providerName !== undefined) {
    options.providerName = config.providerName;
  }

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

  if (config.defaultHeaders !== undefined) {
    options.defaultHeaders = { ...config.defaultHeaders };
  }

  if (config.httpDebugLogging !== undefined) {
    options.httpDebugLogging = config.httpDebugLogging;
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

function pickProviderConfig(
  parsed: OpenAICompatibleConfigDocument
): OpenAICompatibleChatProviderFileConfig {
  return parsed.openaiCompatible ?? parsed.openai ?? parsed;
}

export function loadOpenAICompatibleChatProviderOptionsFromConfigFile(
  options: OpenAICompatibleChatProviderConfigFileOptions = {}
): OpenAICompatibleChatProviderOptions {
  const resolvedPath = resolveConfigPath(options.configPath);
  let fileOptions: OpenAICompatibleChatProviderOptions = {};

  if (resolvedPath) {
    const parsed = parseConfigDocument(resolvedPath);
    fileOptions = toProviderOptions(pickProviderConfig(parsed));
  }

  return {
    ...fileOptions,
    ...options.overrides,
    ...(options.overrides?.httpDebugLogging &&
    typeof options.overrides.httpDebugLogging === "object" &&
    !Array.isArray(options.overrides.httpDebugLogging) &&
    fileOptions.httpDebugLogging &&
    typeof fileOptions.httpDebugLogging === "object" &&
    !Array.isArray(fileOptions.httpDebugLogging)
      ? {
          httpDebugLogging: {
            ...fileOptions.httpDebugLogging,
            ...options.overrides.httpDebugLogging
          }
        }
      : {}),
    ...(options.overrides?.defaultHeaders
      ? {
          defaultHeaders: {
            ...(fileOptions.defaultHeaders ?? {}),
            ...options.overrides.defaultHeaders
          }
        }
      : {})
  };
}

export function resolveOpenAICompatibleChatConfigPath(configPath?: string): string | null {
  return resolveConfigPath(configPath);
}

export function createOpenAICompatibleChatProviderFromConfigFile(
  options?: OpenAICompatibleChatProviderConfigFileOptions
): AIProvider {
  return createOpenAICompatibleChatProvider(
    loadOpenAICompatibleChatProviderOptionsFromConfigFile(options)
  );
}

export function loadOpenAIChatProviderOptionsFromConfigFile(
  options: OpenAIChatProviderConfigFileOptions = {}
): OpenAIChatProviderOptions {
  return loadOpenAICompatibleChatProviderOptionsFromConfigFile(options);
}

export function resolveOpenAIChatConfigPath(configPath?: string): string | null {
  return resolveOpenAICompatibleChatConfigPath(configPath);
}

export function createOpenAIChatProviderFromConfigFile(
  options?: OpenAIChatProviderConfigFileOptions
): AIProvider {
  return createOpenAIChatProvider(loadOpenAIChatProviderOptionsFromConfigFile(options));
}
