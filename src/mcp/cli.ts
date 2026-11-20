import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadMcpConfig } from "./config.js";
import { McpWorkflowService } from "./service.js";
import { serveMcpStdio } from "./stdio.js";
import { runMcpWorker } from "./worker.js";

const usage = "Usage: atk-mcp --config <config.json> | atk-mcp init <empty-directory>";

async function initProject(directory: string) {
  const target = resolve(directory);
  await mkdir(target, { recursive: true });
  if ((await readdir(target)).length) throw new Error("Choose an empty directory for the pipeline project.");
  const source = new URL("../templates/pipeline/", import.meta.url);
  const files = await Promise.all((await readdir(source)).map(async name =>
    ({ name, content: await readFile(new URL(name, source), "utf8") })));
  const manifest = {
    name: "atk-pipeline-starter", private: true, type: "module",
    dependencies: { "agentic-task-kit": packageVersion() },
    scripts: { setup: "node setup.mjs", local: "node local.mjs", serve: "atk-mcp --config atk-mcp.json" },
  };
  files.push({ name: "package.json", content: JSON.stringify(manifest, null, 2) + "\n" });
  const created: string[] = [];
  try {
    for (const { name, content } of files) {
      const path = join(target, name);
      await writeFile(path, content, { flag: "wx" });
      created.push(path);
    }
  } catch (error) {
    await Promise.allSettled(created.map(path => unlink(path)));
    throw error;
  }
  process.stdout.write("Created pipeline project at " + target + "\n");
}

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
  if (args.length === 2 && args[0] === "init" && args[1]) return initProject(args[1]);
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
