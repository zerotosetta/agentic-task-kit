import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAIProviderFromConfigFile,
  createCycle,
  createWorkflowInput,
  type AIProvider,
  type ExecutionObserver,
} from "agentic-task-kit";
import { BxcaRequirementsWorkflow } from "./bxca-workflow.js";
import { createOutputDirName, serializeRecords, writeJson } from "./sample-files.js";

export const bxcaProjectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const bxcaDefaultInput = resolve(bxcaProjectRoot, "inputs", "transfer-limit-requirements.md");
export const bxcaDemoCommand = fileURLToPath(new URL("../scripts/bxca-demo.mjs", import.meta.url));

export function createBxcaSampleProvider(options: {
  demo?: boolean;
  env?: NodeJS.ProcessEnv;
} = {}): AIProvider {
  const env = options.env ?? process.env;
  const model = env.BXCA_MODEL?.trim();
  const timeoutMs = env.BXCA_TIMEOUT_MS === undefined ? 180_000 : Number(env.BXCA_TIMEOUT_MS);
  if ((env.BXCA_TIMEOUT_MS !== undefined && !env.BXCA_TIMEOUT_MS.trim()) ||
      !Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647) {
    throw new Error("BXCA_TIMEOUT_MS must be an integer between 0 and 2147483647.");
  }

  return createAIProviderFromConfigFile({
    configPath: resolve(bxcaProjectRoot, "cycle.bxca.config.json"),
    overrides: {
      providerName: "cli",
      timeoutMs,
      ...(model ? { defaultModel: model } : {}),
      command: {
        executable: options.demo ? process.execPath : (env.BXCA_EXECUTABLE ?? "bxca"),
        args: [
          ...(options.demo ? [bxcaDemoCommand] : []),
          "-p", "{message}",
          ...(model ? ["-m", "{model}"] : []),
        ],
        cwd: bxcaProjectRoot,
      },
    },
  });
}

export async function runBxcaSample(options: {
  aiProvider: AIProvider;
  inputPath?: string;
  outputRoot?: string;
  observers?: ExecutionObserver[];
}) {
  const inputPath = resolve(options.inputPath ?? bxcaDefaultInput);
  const outputDir = resolve(
    options.outputRoot ?? resolve(bxcaProjectRoot, "generated"),
    `bxca-${createOutputDirName(inputPath, { unique: true })}`,
  );
  await mkdir(outputDir, { recursive: true });
  const cycle = createCycle({
    aiProvider: options.aiProvider,
    observers: options.observers ?? [],
  });
  cycle.register("bxca-requirements", BxcaRequirementsWorkflow);
  const result = await cycle.run("bxca-requirements", createWorkflowInput({ inputPath, outputDir }));

  await writeJson(resolve(outputDir, "90-memory-snapshot.json"), {
    active: serializeRecords(result.memory.activeRecords),
    archived: serializeRecords(result.memory.archivedRecords),
  });
  await writeJson(resolve(outputDir, "91-run-frame.json"), result.frame);
  return { ...result, outputDir };
}
