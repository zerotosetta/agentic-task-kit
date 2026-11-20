import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sandbox = await mkdtemp(join(tmpdir(), "atk-installed-sdk-"));
const app = join(sandbox, "my pipeline");
const toolsDir = join(sandbox, "bootstrap");
const npm = process.env.npm_execpath;
assert.ok(npm, "Invoke via npm run test:sdk-package.");

function node(args, cwd = app) {
  return execFileSync(process.execPath, args, { cwd, encoding: "utf8", timeout: 60_000, windowsHide: true });
}
const plan = {
  steps: [
    { id: "measure", operation: "count_words", args: { text: { from: "request", path: ["text"] } } },
    { id: "render", operation: "format", args: { count: { from: "step", step: "measure", path: ["count"] } } },
  ],
  result: { from: "step", step: "render" },
};
const goals = [];
const provider = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try {
    const context = JSON.parse(JSON.parse(Buffer.concat(chunks)).messages.at(-1).content);
    goals.push(context.goal);
    assert.deepEqual(context.operations.map(op => op.key), ["normalize", "count_words", "format"]);
    const content = JSON.stringify(context.attempt === 1 ? { steps: [], result: {} } : plan);
    res.writeHead(200, {"content-type": "application/json"}).end(JSON.stringify({
      id: "sdk-test", object: "chat.completion", created: 1, model: "fixture",
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    }));
  } catch (error) {
    res.writeHead(400).end(String(error));
  }
});

let client;
let embedded;
try {
  await mkdir(toolsDir);
  const packed = JSON.parse(node([npm, "pack", "./.npm-package", "--pack-destination", sandbox, "--json"], root));
  const tarball = join(sandbox, packed[0].filename);
  const install = cwd => node([npm, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball], cwd);
  install(toolsDir);
  const cliPath = dir => join(dir, "node_modules", "agentic-task-kit", "dist", "atk-mcp.js");
  node([cliPath(toolsDir), "init", app], toolsDir);
  install(app);
  node(["setup.mjs"]);
  assert.deepEqual(JSON.parse(node(["local.mjs", "alpha beta gamma"])).output, { report: "Words: 3" });
  const cli = cliPath(app);
  const sdk = await import(pathToFileURL(join(dirname(cli), "index.js")).href);
  const configPath = join(app, "atk-mcp.json");
  const config = JSON.parse(await readFile(configPath, "utf8"));
  config.profiles["planned-report"].maxSteps = 1;
  await writeFile(configPath, JSON.stringify(config));
  await new Promise((ok, fail) => provider.once("error", fail).listen(0, "127.0.0.1", ok));
  const modelConfig = join(app, "test-model.json");
  await writeFile(modelConfig, JSON.stringify({
    baseURL: `http://127.0.0.1:${provider.address().port}/v1`, defaultModel: "fixture", apiKey: "local-test", maxRetries: 0,
  }));
  const connect = model => sdk.connectMcpClient({
    command: process.execPath, args: [cli, "--config", configPath], cwd: app,
    env: { ...process.env, ATK_PLANNER_CONFIG: model ? modelConfig : join(app, "unavailable-config.json") },
  });
  client = await connect(true);
  const call = (name, args = {}) => client.callToolValue(name, args);
  async function waitFor(runId, target) {
    const deadline = Date.now() + 30_000;
    do {
      const state = await call("workflow_progress", { runId });
      if (state.status === target) return state;
      assert.ok(["running", "queued"].includes(state.status), JSON.stringify(state));
      await delay(50);
    } while (Date.now() < deadline);
    throw new Error("Timed out waiting for " + target);
  }
  assert.equal((await call("workflow_list")).profiles.length, 3);
  const described = await call("workflow_describe", { profile: "submitted-report" });
  assert.deepEqual(described.operations.map(op => op.key), ["normalize", "count_words", "format"]);
  assert.deepEqual(described.inputSchema.required.toSorted(), ["input", "plan"]);
  await assert.rejects(call("workflow_start", { profile: "word-report", idempotencyKey: "bad", request: { text: 5 } }), /string/);
  const request = { goal: "Count the words and format the result", text: "one two three" };
  const start = { profile: "planned-report", idempotencyKey: "one-report", request };
  const { runId } = await call("workflow_start", start);
  const first = await waitFor(runId, "interrupted");
  assert.equal(first.lastCompletedStep.stepKey, "measure");
  assert.deepEqual(first.stage, { stepKey: "render", phase: "interrupted", position: 2, total: 2 });
  assert.deepEqual(goals, [request.goal, request.goal]);

  await client.close();
  client = await connect(false);
  assert.equal((await call("workflow_start", start)).runId, runId);
  await call("workflow_resume", { runId, expectedCheckpointSeq: 1 });
  const done = await waitFor(runId, "completed");
  const ref = done.lastCompletedStep.outcome.detailsRef;
  assert.deepEqual(JSON.parse(Buffer.from(await client.readWorkflowArtifact(runId, ref, { pageBytes: 7 }))), { report: "Words: 3" });
  const planArtifact = (await call("workflow_results", { runId })).artifacts.find(item => item.kind === "pipeline-plan");
  assert.ok(planArtifact);
  assert.deepEqual(JSON.parse(Buffer.from(await client.readWorkflowArtifact(runId, planArtifact))).plan, plan);
  assert.equal(goals.length, 2);
  const submitted = await call("workflow_start", {profile:"submitted-report", idempotencyKey:"from-agent", request:{input:request, plan}});
  assert.equal((await waitFor(submitted.runId, "completed")).lastCompletedStep.stepKey, "render");
  assert.equal(goals.length, 2);
  embedded = sdk.openWorkflowTools(configPath);
  assert(embedded.listTools().some(tool => tool.name === "workflow_progress"));
  assert.equal((await embedded.callTool("workflow_status", { runId })).structuredContent.status, "completed");
  const embeddedStart = await embedded.callTool("workflow_start", {
    profile: "word-report", request: { text: "embedded host" }, idempotencyKey: "embedded",
  });
  assert.equal(embeddedStart.isError, false);
  const embeddedRun = embeddedStart.structuredContent.runId;
  const embeddedOutput = (await waitFor(embeddedRun, "completed")).lastCompletedStep.outcome.detailsRef;
  assert.deepEqual(JSON.parse(Buffer.from(await client.readWorkflowArtifact(embeddedRun, embeddedOutput))), {report:"Words: 2"});
  console.log("Installed SDK passed: scaffold, local and nested MCP, model plan repair, pinned resume, submitted plan, embedded host and verified result.");
} finally {
  embedded?.close();
  await client?.close();
  if (provider.listening) await new Promise(resolve => provider.close(resolve));
  await rm(sandbox, {recursive: true, force: true, maxRetries: 8, retryDelay: 150});
}
