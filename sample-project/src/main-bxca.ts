import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { createCLIRenderer } from "agentic-task-kit";
import { createBxcaSampleProvider, runBxcaSample } from "./bxca-sample.js";
import { resolveRendererOptions } from "./sample-runtime.js";

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      demo: { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
  });
  if (values.help) {
    process.stdout.write("Usage: npm run start:bxca -- [--demo] [requirements.md]\nEnvironment: BXCA_EXECUTABLE, BXCA_MODEL, BXCA_TIMEOUT_MS, CYCLE_RENDER_MODE\n");
    return;
  }
  if (positionals.length > 1) throw new Error("Pass at most one requirements file.");
  process.stdout.write(values.demo
    ? "bxca demo: local fixture, no model calls.\n"
    : "bxca: running 3 model requests through the registered CLI.\n");
  const result = await runBxcaSample({
    aiProvider: createBxcaSampleProvider({ demo: values.demo }),
    ...(positionals[0] ? { inputPath: resolve(positionals[0]) } : {}),
    observers: [createCLIRenderer({ mode: "line", ...resolveRendererOptions() })],
  });
  process.stdout.write(`bxca sample status=${result.frame.status} outputDir=${result.outputDir}\n`);
  if (result.frame.status !== "success") {
    process.stderr.write(`${result.frame.errors.join("\n")}\n`);
    process.exitCode = 1;
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(`bxca sample: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
