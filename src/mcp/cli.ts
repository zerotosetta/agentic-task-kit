import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadMcpConfig } from "./config.js";
import { McpWorkflowService } from "./service.js";
import { serveMcpStdio } from "./stdio.js";
import { runMcpWorker } from "./worker.js";

const usage = "Usage: atk-mcp --config <config.json>";

function packageVersion(): string {
  try {
    const { name, version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    if (name === "agentic-task-kit" && typeof version === "string") return version;
  } catch {
    // Development bundles can run without a package manifest.
  }
  return "dev";
}

async function main(args: string[]): Promise<void> {
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    process.stdout.write(usage + "\n");
    return;
  }
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(packageVersion() + "\n");
    return;
  }
  const [configFlag, configPath, mode, runId, token] = args;
  if (configFlag !== "--config" || !configPath || (args.length !== 2 && !(args.length === 5 && mode === "--worker" && runId && token))) {
    throw new Error(usage);
  }
  const config = loadMcpConfig(configPath);
  if (mode === "--worker" && runId && token) {
    await runMcpWorker(config, runId, token);
    return;
  }
  const service = new McpWorkflowService(config, fileURLToPath(import.meta.url));
  try {
    await serveMcpStdio((name, input, signal) => service.call(name, input, signal), { serverVersion: packageVersion() });
  } finally {
    service.close();
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write("atk-mcp: " + (error instanceof Error ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
