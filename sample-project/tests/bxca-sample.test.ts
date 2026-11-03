import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createCommandAIProvider } from "agentic-task-kit";
import { bxcaProjectRoot, createBxcaSampleProvider, runBxcaSample } from "../src/bxca-sample.js";

const fixture = fileURLToPath(new URL("./fixtures/bxca.mjs", import.meta.url));

async function setup(t: TestContext, text = "# 요구사항\n한글과 \"따옴표\", & %PATH% $() {message}를 그대로 보존한다.") {
  const root = await mkdtemp(join(tmpdir(), "atk-bxca-"));
  t.after(async () => {
    assert.equal(dirname(root), tmpdir());
    assert.ok(root.startsWith(join(tmpdir(), "atk-bxca-")));
    await rm(root, { recursive: true, force: true });
  });
  const inputPath = join(root, "한글 요구사항.md");
  await writeFile(inputPath, text, "utf8");
  return { root, inputPath, outputRoot: root, text };
}

function fixtureProvider(root: string, behavior = "success", timeoutMs = 5_000) {
  return createCommandAIProvider({
    defaultModel: "fixture-model",
    timeoutMs,
    command: {
      executable: process.execPath,
      args: [fixture, "--behavior", behavior, "-p", "{message}", "-m", "{model}"],
      env: { BXCA_FIXTURE_TRACE: join(root, "trace.jsonl") },
    },
  });
}

test("bxca command pipeline preserves input and passes memory between three real child processes", async (t) => {
  const input = await setup(t);
  const result = await runBxcaSample({ ...input, aiProvider: fixtureProvider(input.root) });
  assert.equal(result.frame.status, "success");
  assert.deepEqual(result.frame.completedTasks, ["load", "analysis", "plan", "review"]);
  const trace = (await readFile(join(input.root, "trace.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(trace.map((row) => row.stage), ["analysis", "plan", "review"]);
  for (const row of trace) {
    assert.equal(row.documents.requirements, input.text);
    assert.equal(row.model, "fixture-model");
  }
  assert.equal(trace[2].documents.analysis, "# fixture analysis\n");
  assert.equal(trace[2].documents.plan, "# fixture plan\n");
  assert.deepEqual((await readdir(result.outputDir)).sort(), [
    "00-requirements.md", "01-analysis.md", "02-plan.md", "03-review.md",
    "90-memory-snapshot.json", "91-run-frame.json",
  ]);
  for (const artifact of result.artifacts.artifacts) {
    assert.equal(await readFile(join(result.outputDir, artifact.name), "utf8"), new TextDecoder().decode(artifact.bytes));
  }
  assert.equal(result.artifacts.artifacts.length, 4);
  const memory = JSON.parse(await readFile(join(result.outputDir, "90-memory-snapshot.json"), "utf8"));
  const documents = memory.active.find((record: { id: string }) => record.id.includes("bxca-documents"));
  assert.equal(JSON.parse(documents.payload.contextSummary).review, "# fixture review\n");
});

test("failed command retains completed artifacts and stops before review", async (t) => {
  const input = await setup(t);
  const result = await runBxcaSample({ ...input, aiProvider: fixtureProvider(input.root, "fail-plan") });
  assert.equal(result.frame.status, "fail");
  assert.deepEqual(result.frame.failedTasks, ["plan"]);
  assert.deepEqual(result.frame.completedTasks, ["load", "analysis"]);
  assert.equal(result.artifacts.artifacts.length, 2);
  assert.ok(!(await readdir(result.outputDir)).includes("03-review.md"));
  const saved = JSON.parse(await readFile(join(result.outputDir, "91-run-frame.json"), "utf8"));
  assert.equal(saved.status, "fail");
  assert.match(JSON.stringify(saved), /fixture plan failed/);
});

test("empty stdout is a workflow failure", async (t) => {
  const input = await setup(t);
  const result = await runBxcaSample({ ...input, aiProvider: fixtureProvider(input.root, "empty") });
  assert.deepEqual(result.frame.failedTasks, ["analysis"]);
  assert.match(result.frame.errors.join("\n"), /non-empty text/);
});

test("timeout fails analysis and retains its run frame", async (t) => {
  const input = await setup(t);
  const result = await runBxcaSample({ ...input, aiProvider: fixtureProvider(input.root, "slow", 100) });
  assert.equal(result.frame.status, "fail");
  assert.deepEqual(result.frame.failedTasks, ["analysis"]);
  assert.match(JSON.stringify(result.frame), /command_timeout|timed out/i);
  assert.ok((await readdir(result.outputDir)).includes("91-run-frame.json"));
});

test("oversized requirements fail before any command is launched", async (t) => {
  const input = await setup(t, "x".repeat(6_001));
  const result = await runBxcaSample({ ...input, aiProvider: fixtureProvider(input.root) });
  assert.deepEqual(result.frame.failedTasks, ["load"]);
  assert.match(result.frame.errors.join("\n"), /6000/);
  assert.ok(!(await readdir(input.root)).includes("trace.jsonl"));
});

test("bundled demo uses the command factory without bxca or API credentials", async (t) => {
  const input = await setup(t);
  const result = await runBxcaSample({ ...input, aiProvider: createBxcaSampleProvider({ demo: true, env: {} }) });
  assert.equal(result.frame.status, "success");
  assert.match(await readFile(join(result.outputDir, "03-review.md"), "utf8"), /로컬 데모/);
  assert.throws(() => createBxcaSampleProvider({ env: { BXCA_TIMEOUT_MS: "invalid" } }), /BXCA_TIMEOUT_MS/);
  assert.throws(() => createBxcaSampleProvider({ env: { BXCA_TIMEOUT_MS: "" } }), /BXCA_TIMEOUT_MS/);
});

test("CLI returns exit code 1 and saves a failed frame for missing input", async (t) => {
  const input = await setup(t);
  const child = spawnSync(process.execPath, ["--import", "tsx", "src/main-bxca.ts", "--demo", join(input.root, "missing.md")], {
    cwd: bxcaProjectRoot,
    env: { ...process.env, CYCLE_RENDER_MODE: "line", CYCLE_LIVE: "0" },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /ENOENT/);
  const outputDir = /outputDir=(.+)/.exec(child.stdout)?.[1]?.trim();
  assert.ok(outputDir);
  const frame = JSON.parse(await readFile(join(outputDir, "91-run-frame.json"), "utf8"));
  assert.deepEqual(frame.failedTasks, ["load"]);
});
