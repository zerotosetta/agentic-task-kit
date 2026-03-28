import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadOpenAICompatibleChatProviderOptionsFromConfigFile,
  resolveOpenAICompatibleChatConfigPath,
  loadOpenAIChatProviderOptionsFromConfigFile,
  resolveOpenAIChatConfigPath
} from "../src/index.js";

describe("OpenAI config file support", () => {
  let tempDir: string | null = null;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = null;
    }

    delete process.env.CYCLE_OPENAI_CONFIG_PATH;
    delete process.env.CYCLE_OPENAI_COMPATIBLE_CONFIG_PATH;
    delete process.env.SAMPLE_OPENAI_KEY;
  });

  it("loads provider options from a separate config file", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cycle-openai-config-"));
    const configPath = join(tempDir, "cycle.config.json");
    process.env.SAMPLE_OPENAI_KEY = "test-key-from-env";

    await writeFile(
      configPath,
      JSON.stringify(
        {
          openai: {
            apiKeyEnv: "SAMPLE_OPENAI_KEY",
            defaultModel: "gpt-5.2",
            timeoutMs: 12000,
            maxRetries: 3
          }
        },
        null,
        2
      ),
      "utf8"
    );

    const options = loadOpenAIChatProviderOptionsFromConfigFile({ configPath });

    expect(options.apiKey).toBe("test-key-from-env");
    expect(options.defaultModel).toBe("gpt-5.2");
    expect(options.timeoutMs).toBe(12000);
    expect(options.maxRetries).toBe(3);
  });

  it("resolves config path from CYCLE_OPENAI_CONFIG_PATH when explicit path is omitted", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cycle-openai-config-env-"));
    const configPath = join(tempDir, "cycle.config.json");
    process.env.CYCLE_OPENAI_CONFIG_PATH = configPath;

    await writeFile(
      configPath,
      JSON.stringify(
        {
          openai: {
            defaultModel: "gpt-5.2"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    expect(resolveOpenAIChatConfigPath()).toBe(configPath);
    expect(loadOpenAIChatProviderOptionsFromConfigFile().defaultModel).toBe("gpt-5.2");
  });

  it("loads OpenAI-compatible config sections and default headers", async () => {
    tempDir = await mkdtemp(join(tmpdir(), "cycle-openai-compatible-config-"));
    const configPath = join(tempDir, "cycle.compatible.config.json");
    process.env.SAMPLE_OPENAI_KEY = "test-key-from-env";

    await writeFile(
      configPath,
      JSON.stringify(
        {
          openaiCompatible: {
            providerName: "openrouter",
            apiKeyEnv: "SAMPLE_OPENAI_KEY",
            baseURL: "https://openrouter.ai/api/v1",
            defaultHeaders: {
              "HTTP-Referer": "https://example.test/cycle",
              "X-Title": "Cycle Sample"
            },
            httpDebugLogging: {
              enabled: true,
              includeHeaders: true
            },
            defaultModel: "openai/gpt-5.2-mini"
          }
        },
        null,
        2
      ),
      "utf8"
    );

    process.env.CYCLE_OPENAI_COMPATIBLE_CONFIG_PATH = configPath;

    const options = loadOpenAICompatibleChatProviderOptionsFromConfigFile();

    expect(resolveOpenAICompatibleChatConfigPath()).toBe(configPath);
    expect(options.providerName).toBe("openrouter");
    expect(options.apiKey).toBe("test-key-from-env");
    expect(options.baseURL).toBe("https://openrouter.ai/api/v1");
    expect(options.defaultHeaders).toEqual({
      "HTTP-Referer": "https://example.test/cycle",
      "X-Title": "Cycle Sample"
    });
    expect(options.httpDebugLogging).toEqual({
      enabled: true,
      includeHeaders: true
    });
    expect(options.defaultModel).toBe("openai/gpt-5.2-mini");
  });
});
