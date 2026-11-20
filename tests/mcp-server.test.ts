import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { SqliteDurableExecutionStore } from "../src/durable-store.js";
import { evidenceBytes } from "./fixtures/mcp-workflow.js";
import type { McpWorkflowProgressView, McpWorkflowStatus as Status } from "../src/types/mcp.js";

type Artifact = { id: string; kind: string; sha256: string };
type Artifacts = { runId: string; checkpointSeq: number; artifacts: Artifact[]; nextCursor: string | null };
type ArtifactChunk = {
  runId: string;
  checkpointSeq: number;
  artifact: Artifact;
  offset: number;
  totalBytes: number;
  data: string;
  nextCursor: string | null;
};
type Marker = { pid: number; attemptId: string; artifactId: string; workDirectory: string };
type ToolResult<T> = { content: Array<{ type: string; text: string }>; structuredContent: T; isError?: boolean };
type RpcResponse = { id: number; result?: unknown; error?: { code: number; message: string } };
type Pending = { receive(response: RpcResponse): void; fail(error: Error): void };

const tempRoot = resolve(tmpdir());
const buildPrefix = "atk-mcp-cli-test-";
const testPrefix = "atk-mcp-run-test-";
const revision = "mcp-fixture-v1";
const fixtures: string[] = [];
const clients: ReturnType<typeof connect>[] = [];
const pausedWorkers = new Set<number>();
let buildDirectory: string;
let cliPath: string;
let pluginPath: string;

function source(path: string) {
  return fileURLToPath(new URL(path, import.meta.url));
}

async function removeTemporary(directory: string, prefix: string) {
  const target = resolve(directory);
  if (dirname(target) !== tempRoot || !target.slice(tempRoot.length + 1).startsWith(prefix)) {
    throw new Error("Unexpected test cleanup path.");
  }
  await rm(target, { recursive: true, force: true, maxRetries: 5 });
}

beforeAll(async () => {
  buildDirectory = await mkdtemp(join(tempRoot, buildPrefix));
  cliPath = join(buildDirectory, "cli.mjs");
  pluginPath = join(buildDirectory, "plugin.mjs");
  await build({
    entryPoints: { cli: source("../src/mcp/cli.ts"), plugin: source("./fixtures/mcp-workflow.ts") },
    outdir: buildDirectory,
    outExtension: { ".js": ".mjs" },
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
  });
}, 30_000);

afterAll(async () => {
  if (buildDirectory) await removeTemporary(buildDirectory, buildPrefix);
});

afterEach(async () => {
  for (const client of clients) client.terminate();
  await Promise.all(clients.splice(0).map(client => client.closed));
  for (const pid of pausedWorkers) killFixtureWorker(pid, true);
  pausedWorkers.clear();
  await Promise.all(fixtures.splice(0).map(directory => removeTemporary(directory, testPrefix)));
});

function killFixtureWorker(pid: number, ignoreExited = false) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid || clients.some(client => client.pid === pid)) {
    throw new Error("Invalid detached fixture worker PID.");
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (!ignoreExited || (error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function connect(path: string) {
  const child = spawn(process.execPath, [cliPath, "--config", path], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map<number, Pending>();
  let requestId = 0;
  let stderr = "";
  let stopped = false;
  const diagnostics = () => stderr.trim();
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once("close", (code, signal) => {
      stopped = true;
      fail(new Error(`MCP exited with ${code ?? signal}. ${diagnostics()}`));
      resolve({ code, signal });
    });
  });
  function fail(error: Error) {
    for (const request of pending.values()) request.fail(error);
  }

  child.stderr.setEncoding("utf8").on("data", chunk => { stderr += chunk; });
  child.on("error", fail);
  child.stdin.on("error", fail);
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", line => {
    try {
      const message = JSON.parse(line) as RpcResponse;
      pending.get(message.id)?.receive(message);
    } catch {
      fail(new Error("MCP stdout contained non-JSON data: " + line));
    }
  });

  function write(method: string, params: object, id?: number) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params, id }) + "\n");
  }

  function request<T>(method: string, params: object): Promise<T> {
    const id = ++requestId;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        rejectRequest(new Error(`MCP ${method} timed out. ${diagnostics()}`));
      }, 10_000);
      const cleanup = () => {
        clearTimeout(timeout);
        pending.delete(id);
      };
      const rejectRequest = (error: Error) => {
        cleanup();
        reject(error);
      };
      if (stopped) {
        rejectRequest(new Error("MCP already exited. " + diagnostics()));
        return;
      }
      pending.set(id, {
        receive(response) {
          cleanup();
          if (response.error) reject(new Error(JSON.stringify(response.error)));
          else resolve(response.result as T);
        },
        fail: rejectRequest,
      });
      write(method, params, id);
    });
  }

  return {
    pid: child.pid,
    request,
    call<T>(name: string, args: object) {
      return request<ToolResult<T>>("tools/call", { name, arguments: args });
    },
    discardStartResponse(args: object) {
      write("tools/call", { name: "workflow_start", arguments: args }, ++requestId);
    },
    cancelPendingStatus(runId: string) {
      const id = ++requestId;
      write("tools/call", { name: "workflow_status", arguments: { runId } }, id);
      write("notifications/cancelled", { requestId: id, reason: "test request cancellation" });
    },
    notify(method: string, params: object) { write(method, params); },
    disconnect() { child.stdin.end(); return closed; },
    terminate() { if (!stopped) child.kill("SIGKILL"); },
    closed,
    diagnostics,
  };
}

async function openClient(configPath: string, protocolVersion = "2025-06-18") {
  const client = connect(configPath);
  clients.push(client);
  const handshake = await client.request<{ protocolVersion: string }>("initialize", {
    protocolVersion,
    clientInfo: { name: "atk-test-client", version: "1" },
    capabilities: {},
  });
  expect(handshake.protocolVersion).toBe(protocolVersion);
  client.notify("notifications/initialized", {});
  return client;
}

async function makeFixture(maxSteps?: number) {
  const root = await mkdtemp(join(tempRoot, testPrefix));
  fixtures.push(root);
  const controlDirectory = join(root, "control");
  const configPath = join(root, "mcp.json");
  const modulePath = join(root, "workflow.mjs");
  await mkdir(controlDirectory);
  await copyFile(pluginPath, modulePath);
  async function configure(version = revision, stageOrder?: string[]) {
    await writeFile(configPath, JSON.stringify({
      stateDirectory: "./state",
      leaseMs: 3_000,
      profiles: { fixture: {
        module: "./workflow.mjs",
        revision: version,
        settings: { controlDirectory },
        ...(maxSteps === undefined ? {} : { maxSteps }),
        ...(stageOrder === undefined ? {} : { stageOrder }),
      } },
    }), "utf8");
  }
  await configure();
  return { root, controlDirectory, configPath, modulePath, configure };
}

function data<T>(result: ToolResult<T>): T {
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.structuredContent, JSON.stringify(result)).toBeDefined();
  return result.structuredContent;
}

type Client = Awaited<ReturnType<typeof openClient>>;
type Fixture = Awaited<ReturnType<typeof makeFixture>>;

async function start(client: Client, idempotencyKey: string, mode: string) {
  return data(await client.call<Status>("workflow_start", { profile: "fixture", request: { mode }, idempotencyKey }));
}

async function status(client: Client, runId: string) {
  return data(await client.call<Status>("workflow_status", { runId }));
}

async function progress(client: Client, runId: string) {
  const result = await client.call<McpWorkflowProgressView>("workflow_progress", { runId });
  const view = data(result);
  expect(JSON.parse(result.content[0]!.text)).toEqual(view);
  return view;
}

async function rerunHistory(fixture: Fixture, runId: string) {
  const store = new SqliteDurableExecutionStore(join(fixture.root, "state", "execution.sqlite"));
  try {
    return {
      checkpoints: await store.listCheckpoints(runId),
      attempts: await store.listAttempts(runId),
    };
  } finally {
    store.close();
  }
}

async function untilStatus(client: Client, runId: string, desired: Status["status"]) {
  let observed: Status | undefined;
  await expect.poll(async () => {
    observed = await status(client, runId);
    return observed;
  }, { timeout: 20_000, interval: 100 }).toMatchObject({ status: desired });
  assert.ok(observed);
  return observed;
}

async function untilResumable(client: Client, runId: string) {
  let observed: Status | undefined;
  await expect.poll(async () => {
    observed = await status(client, runId);
    return observed.nextAction.action;
  }, { timeout: 20_000, interval: 100 }).toBe("resume");
  assert.ok(observed);
  return observed;
}

async function workerMarker<T extends { pid: number }>(fixture: Fixture, runId: string, file: string) {
  let marker: T | undefined;
  await expect.poll(async () => {
    try {
      marker = JSON.parse(await readFile(join(fixture.controlDirectory, runId + "." + file), "utf8")) as T;
      return marker.pid > 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
      return false;
    }
  }, { timeout: 20_000, interval: 100 }).toBe(true);
  assert.ok(marker);
  const { pid } = marker;
  expect(clients.some(client => client.pid === pid)).toBe(false);
  pausedWorkers.add(pid);
  return marker;
}

function pausedMarker(fixture: Fixture, runId: string) {
  return workerMarker<Marker>(fixture, runId, "paused.json");
}

describe("ATK stdio MCP durable worker", () => {
  it("publishes a generated stage order when a prerequisite holds the run at checkpoint zero", async () => {
    const fixture = await makeFixture();
    await writeFile(fixture.modulePath, `
      import { createWorkflow as base } from ${JSON.stringify(pathToFileURL(pluginPath).href)};
      export async function createWorkflow(ctx) {
        return { ...await base(ctx), stageOrder: ["collect", "finish"], pauseBeforeFirst: true, pauseBefore: () => true };
      }
    `);
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "waiting-at-start", "simple");
    await untilStatus(client, runId, "interrupted");
    expect(await progress(client, runId)).toMatchObject({
      stage: { phase: "interrupted", stepKey: "collect", position: 1, total: 2 }, lastCompletedStep: null,
    });
    expect((await rerunHistory(fixture, runId)).attempts).toHaveLength(0);
  });
  it("leaves percentages unknown for missing or empty counts, and leaves an unlisted stage unnumbered", async () => {
    const fixture = await makeFixture();
    await fixture.configure(revision, ["collect"]);
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "enumerate-files", "enumerate");
    await expect.poll(() => progress(client, runId), { timeout: 20_000 }).toMatchObject({
      stage: { phase: "executing", stepKey: "finish", position: null, total: 1 },
      detail: { operation: "enumerate", percent: null },
    });
    await writeFile(join(fixture.controlDirectory, runId + ".count-files"), "");
    const marker = await pausedMarker(fixture, runId);
    expect(await progress(client, runId)).toMatchObject({
      detail: { operation: "enumerate", completed: 0, total: 0, unit: "files", percent: null },
    });
    await writeFile(join(fixture.controlDirectory, runId + ".release"), "");
    await untilStatus(client, runId, "completed");
    pausedWorkers.delete(marker.pid);
  }, 60_000);

  it("recovers a lost start receipt and distinguishes productive file progress from a live heartbeat", async () => {
    const fixture = await makeFixture();
    await fixture.configure(revision, ["collect", "finish"]);
    const client = await openClient(fixture.configPath);
    const args = { profile: "fixture", request: { mode: "files" }, idempotencyKey: "lost-receipt" };
    const factories = () => readFile(join(fixture.controlDirectory, "factories.jsonl"), "utf8");
    client.discardStartResponse(args);
    await expect.poll(async () => {
      try { return (await factories()).trim().length > 0; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    }, { timeout: 20_000 }).toBe(true);
    expect(await client.disconnect()).toMatchObject({ code: 0 });
    const reconnected = await openClient(fixture.configPath);
    const { runId } = data(await reconnected.call<Status>("workflow_start", args));
    const originalFactory = JSON.parse((await factories()).trim()) as { runId: string; pid: number };
    expect(originalFactory.runId).toBe(runId);
    pausedWorkers.add(originalFactory.pid);
    await expect.poll(async () => (await status(reconnected, runId)).progress?.completed).toBe(1);
    const first = await status(reconnected, runId);
    expect(first).toMatchObject({
      runId, status: "running", currentStep: "finish", generation: 0, checkpointSeq: 1,
      lastCompletedStep: { stepKey: "collect", generation: 0, checkpointSeq: 1, outcome: { code: "collected" } },
      progress: { operation: "index", stepKey: "finish", item: "page-1.jsp", total: 3, completed: 1, unit: "files" },
      worker: { state: "alive", pid: originalFactory.pid, startedAt: expect.any(String), leaseExpiresAt: expect.any(String) },
      nextAction: { action: "status", tool: "workflow_status", arguments: { runId } },
    });
    assert.ok(first.worker.heartbeatAt && first.lastProgressAt && first.progress);
    expect(await progress(reconnected, runId)).toMatchObject({
      runId, status: "running", stage: { phase: "executing", stepKey: "finish", position: 2, total: 2 },
      lastCompletedStep: first.lastCompletedStep, detail: { ...first.progress, percent: 33 },
      lastProgressAt: first.lastProgressAt, worker: { state: "alive", pid: originalFactory.pid }, error: null,
      nextAction: { action: "status", tool: "workflow_progress", arguments: { runId } },
    });
    // A second client must see the numbering registered at start, even after the profile is edited.
    await fixture.configure(revision, ["finish", "collect", "archive"]);
    const legacy = await openClient(fixture.configPath, "2025-03-26");
    const legacyResult = await legacy.call<McpWorkflowProgressView>("workflow_progress", { runId });
    expect(legacyResult.isError).toBe(false);
    expect(legacyResult).not.toHaveProperty("structuredContent");
    expect(JSON.parse(legacyResult.content[0]!.text)).toMatchObject({
      runId, stage: { phase: "executing", stepKey: "finish", position: 2, total: 2 },
      detail: { ...first.progress, percent: 33 },
    });
    reconnected.cancelPendingStatus(runId);
    await expect.poll(async () => (await status(reconnected, runId)).worker.heartbeatAt).not.toBe(first.worker.heartbeatAt);
    expect(await status(reconnected, runId)).toMatchObject({
      cancelRequested: false, progress: first.progress, checkpointSeq: 1, lastProgressAt: first.lastProgressAt,
    });
    expect(await reconnected.call("workflow_resume", { runId })).toMatchObject({
      isError: true, structuredContent: { code: "RUN_ACTIVE", message: expect.stringContaining(`workflow_status with runId "${runId}"`) },
    });
    await writeFile(join(fixture.controlDirectory, runId + ".release-1"), "");
    await expect.poll(async () => (await status(reconnected, runId)).progress?.completed).toBe(2);
    const second = await status(reconnected, runId);
    expect(second).toMatchObject({ checkpointSeq: 1, progress: { completed: 2, item: "page-2.jsp" } });
    expect(second.progress!.sequence).toBeGreaterThan(first.progress.sequence);
    expect((await progress(reconnected, runId)).detail).toEqual({ ...second.progress, percent: 66 });
    expect(Date.parse(second.lastProgressAt!)).toBeGreaterThan(Date.parse(first.lastProgressAt));
    await writeFile(join(fixture.controlDirectory, runId + ".release-2"), "");
    const done = await untilStatus(reconnected, runId, "completed");
    expect(done).toMatchObject({
      checkpointSeq: 2, currentStep: null, lastCompletedStep: { stepKey: "finish", checkpointSeq: 2 },
      nextAction: { action: "results", tool: "workflow_results", arguments: { runId } },
    });
    expect(await progress(reconnected, runId)).toMatchObject({
      runId, status: "completed", stage: { phase: "completed", stepKey: null, position: null, total: 2 },
      lastCompletedStep: done.lastCompletedStep, nextAction: done.nextAction, error: null,
    });
    expect((await factories()).trim().split("\n")).toHaveLength(1);
    expect(await readdir(join(fixture.root, "state", "runs"))).toEqual([runId]);
    const { checkpoints, attempts } = await rerunHistory(fixture, runId);
    expect(checkpoints.map(c => c.checkpointSeq)).toEqual([0, 1, 2]);
    expect(attempts.map(a => a.status)).toEqual(["committed", "committed"]);
    pausedWorkers.delete(originalFactory.pid);
  }, 60_000);

  it("keeps working across a client disconnect, deduplicates start and pages committed bytes", async () => {
    const fixture = await makeFixture();
    const client = await openClient(fixture.configPath);
    const listed = await client.request<{ tools: Array<{ name: string }> }>("tools/list", {});
    expect(listed.tools.map(tool => tool.name).sort()).toEqual([
      "workflow_cancel", "workflow_describe", "workflow_list", "workflow_progress", "workflow_rerun", "workflow_results", "workflow_resume", "workflow_start", "workflow_status",
    ]);
    expect(listed.tools.find(tool => tool.name === "workflow_progress")).toMatchObject({
      annotations: { readOnlyHint: true },
      inputSchema: { properties: { runId: { type: "string", minLength: 1 } }, required: ["runId"], additionalProperties: false },
    });
    expect(await client.call("workflow_progress", { runId: "missing" })).toMatchObject({
      isError: true, structuredContent: { code: "RUN_NOT_FOUND" },
    });
    expect(await client.call("workflow_progress", { runId: "missing", extra: true })).toMatchObject({
      isError: true, structuredContent: { code: "INVALID_ARGUMENT" },
    });

    const { runId } = await start(client, "same-request", "wait");
    expect((await start(client, "same-request", "wait")).runId).toBe(runId);
    const collision = await client.call("workflow_start", {
      profile: "fixture", request: { mode: "different" }, idempotencyKey: "same-request",
    });
    expect(collision.isError).toBe(true);
    const marker = await pausedMarker(fixture, runId);
    expect(await status(client, runId)).toMatchObject({
      status: "running", checkpointSeq: 1, generation: 0, currentStep: "finish", domainStatus: "collected",
    });
    expect(await progress(client, runId)).toMatchObject({
      stage: { phase: "executing", stepKey: "finish", position: null, total: null }, detail: null,
    });
    const initialResults = data(await client.call<Artifacts>("workflow_results", { runId }));
    expect(initialResults.artifacts.map(artifact => artifact.kind)).toEqual(["fixture-page"]);
    expect((await client.call("workflow_results", { runId, artifactId: marker.artifactId })).isError).toBe(true);

    // The host's wait expires while the detached worker is inside the blocked stage.
    const hostDeadline = AbortSignal.timeout(100);
    const waitForCompletion = async () => {
      while ((await status(client, runId)).status !== "completed") {
        await delay(20, undefined, { signal: hostDeadline });
      }
    };
    await expect(waitForCompletion()).rejects.toMatchObject({ name: "AbortError" });
    expect(await client.disconnect(), client.diagnostics()).toMatchObject({ code: 0 });
    const reconnected = await openClient(fixture.configPath);
    expect(await status(reconnected, runId)).toMatchObject({
      status: "running", checkpointSeq: 1, currentStep: "finish", cancelRequested: false,
    });
    process.kill(marker.pid, 0);
    await writeFile(join(fixture.controlDirectory, runId + ".release"), "");
    const final = await untilStatus(reconnected, runId, "completed");
    pausedWorkers.delete(marker.pid);
    expect(final).toMatchObject({
      checkpointSeq: 2, generation: 0, currentStep: null, domainStatus: "verified",
      outcome: { coverage: { count: 2, complete: true }, previousAttemptId: null },
    });

    const { artifacts } = data(await reconnected.call<Artifacts>("workflow_results", { runId }));
    expect(artifacts.map(artifact => artifact.kind).sort()).toEqual(["fixture-page", "fixture-spec"]);
    const collected = artifacts.find(item => item.kind === "fixture-page");
    const result = artifacts.find(item => item.kind === "fixture-spec");
    assert.ok(collected && result);
    expect(result.sha256).toBe(createHash("sha256").update(evidenceBytes).digest("hex"));
    const chunks: Buffer[] = [];
    let cursor: string | null = null;
    let offset = 0;
    for (let page = 0; page < 20; page += 1) {
      const chunk: ArtifactChunk = data(await reconnected.call<ArtifactChunk>("workflow_results", {
        runId, artifactId: result.id, maxBytes: 7, ...(cursor ? { cursor } : {}),
      }));
      expect(chunk).toMatchObject({ artifact: result, offset, totalBytes: Buffer.byteLength(evidenceBytes) });
      const bytes = Buffer.from(chunk.data, "base64");
      expect(bytes.length).toBeGreaterThan(0);
      expect(bytes.length).toBeLessThanOrEqual(7);
      chunks.push(bytes);
      offset += bytes.length;
      cursor = chunk.nextCursor;
      if (page === 0 && cursor) {
        const wrongArtifact = await reconnected.call("workflow_results", {
          runId, artifactId: collected.id, cursor,
        });
        expect(wrongArtifact.isError).toBe(true);
      }
      if (!cursor) break;
    }
    expect(cursor).toBeNull();
    expect(Buffer.concat(chunks).toString("utf8")).toBe(evidenceBytes);
  }, 60_000);

  it("reopens a crashed worker checkpoint and resumes only its uncommitted work", async () => {
    const fixture = await makeFixture();
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "crash-request", "wait");
    const marker = await pausedMarker(fixture, runId);
    const previous = await status(client, runId);
    expect(previous).toMatchObject({ status: "running", checkpointSeq: 1, currentStep: "finish" });
    killFixtureWorker(marker.pid);
    pausedWorkers.delete(marker.pid);
    expect(await untilStatus(client, runId, "interrupted")).toMatchObject({
      worker: { state: "stopped", pid: marker.pid }, error: { code: "WORKER_EXITED" },
    });
    expect(await client.disconnect(), client.diagnostics()).toMatchObject({ code: 0 });

    const reconnected = await openClient(fixture.configPath);
    const interrupted = await untilResumable(reconnected, runId);
    expect(interrupted.checkpointSeq).toBe(previous.checkpointSeq);
    const original = data(await reconnected.call<Artifacts>("workflow_results", { runId }));
    expect(original.artifacts).toHaveLength(1);
    expect((await reconnected.call("workflow_resume", { runId, expectedCheckpointSeq: 0 })).isError).toBe(true);
    expect((await reconnected.call("workflow_resume", { runId, expectedInputSha256: "0".repeat(64) })).isError).toBe(true);
    expect(await status(reconnected, runId)).toMatchObject({ checkpointSeq: 1, status: "interrupted" });
    expect(await reconnected.disconnect(), reconnected.diagnostics()).toMatchObject({ code: 0 });

    await fixture.configure("mcp-fixture-changed");
    const drifted = await openClient(fixture.configPath);
    expect((await drifted.call("workflow_resume", { runId })).isError).toBe(true);
    expect(await status(drifted, runId)).toMatchObject({ checkpointSeq: 1, status: "interrupted" });
    expect(await drifted.disconnect(), drifted.diagnostics()).toMatchObject({ code: 0 });

    await fixture.configure();
    const recovered = await openClient(fixture.configPath);
    data(await recovered.call<Status>("workflow_resume", {
      runId, expectedCheckpointSeq: 1, expectedInputSha256: interrupted.inputSha256,
    }));
    const final = await untilStatus(recovered, runId, "completed");
    expect(final).toMatchObject({
      checkpointSeq: 2, domainStatus: "verified",
      outcome: { previousAttemptId: marker.attemptId, workDirectory: marker.workDirectory },
    });
    const { artifacts } = data(await recovered.call<Artifacts>("workflow_results", { runId }));
    expect(artifacts).toContainEqual(original.artifacts[0]);
    expect(artifacts.map(artifact => artifact.id)).not.toContain(marker.artifactId);
    expect(await readdir(join(fixture.root, "state", "runs"))).toEqual([runId]);
    expect((await rerunHistory(fixture, runId)).attempts.map(a => [a.work.stepKey, a.status])).toEqual([
      ["collect", "committed"], ["finish", "interrupted"], ["finish", "committed"],
    ]);
  }, 60_000);

  it("cancels executing jobs explicitly and retains the checkpoint for a later resume", async () => {
    const fixture = await makeFixture();
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "cancel-request", "wait");
    const marker = await pausedMarker(fixture, runId);
    client.cancelPendingStatus(runId);
    expect(await status(client, runId)).toMatchObject({ status: "running", cancelRequested: false });

    data(await client.call<Status>("workflow_cancel", { runId }));
    const cancelled = await untilStatus(client, runId, "cancelled");
    pausedWorkers.delete(marker.pid);
    expect(cancelled).toMatchObject({ checkpointSeq: 1, currentStep: "finish", domainStatus: "collected" });
    expect(await progress(client, runId)).toMatchObject({
      status: "cancelled", stage: { phase: "cancelled", stepKey: "finish" }, detail: null,
    });
    expect((await client.call("workflow_results", { runId, artifactId: marker.artifactId })).isError).toBe(true);
    data(await client.call<Status>("workflow_resume", { runId, expectedCheckpointSeq: 1 }));
    expect(await untilStatus(client, runId, "completed")).toMatchObject({
      checkpointSeq: 2, outcome: { previousAttemptId: marker.attemptId },
    });
  }, 60_000);

  it("applies a plugin's checkpoint-driven input generation transition before its next work", async () => {
    const fixture = await makeFixture(1);
    const client = await openClient(fixture.configPath);
    const { runId } = data(await client.call<Status>("workflow_start", {
      profile: "fixture", idempotencyKey: "generation-request", request: { mode: "generation", observeTransition: true },
    }));
    const paused = await untilStatus(client, runId, "interrupted");
    expect(paused).toMatchObject({ checkpointSeq: 1, generation: 0, currentStep: "prepare-input" });
    expect(await client.disconnect(), client.diagnostics()).toMatchObject({ code: 0 });
    const reconnected = await openClient(fixture.configPath);
    data(await reconnected.call<Status>("workflow_resume", { runId, expectedCheckpointSeq: 1 }));
    const marker = await pausedMarker(fixture, runId);
    expect(await status(reconnected, runId)).toMatchObject({
      checkpointSeq: 2, generation: 1, currentStep: "finish-transition",
      lastCompletedStep: { checkpointSeq: 1, generation: 0, stepKey: "collect", outcome: { code: "collected" } },
    });
    await writeFile(join(fixture.controlDirectory, runId + ".release"), "");
    expect(await untilStatus(reconnected, runId, "completed")).toMatchObject({
      checkpointSeq: 3, generation: 1, domainStatus: "generation-checked",
      lastCompletedStep: { checkpointSeq: 3, generation: 1, stepKey: "finish-transition" },
      outcome: { generation: 1, original: "page-one" },
    });
    pausedWorkers.delete(marker.pid);
    await expect(access(join(fixture.controlDirectory, runId + ".factory-resume"))).resolves.toBeUndefined();
    await expect(access(join(fixture.controlDirectory, runId + ".prepare-next"))).resolves.toBeUndefined();
    const { checkpoints } = await rerunHistory(fixture, runId);
    expect(checkpoints.filter(c => c.inputChange).map(c => c.checkpointSeq)).toEqual([2]);
    expect(checkpoints.filter(c => c.committed).map(c => c.committed!.stepKey)).toEqual(["collect", "finish-transition"]);
    const { artifacts } = data(await reconnected.call<Artifacts>("workflow_results", { runId }));
    expect(artifacts.map(artifact => artifact.kind)).toContain("fixture-page");
  }, 60_000);

  it("preserves all seven domain stage commits when an input change adds a separate checkpoint", async () => {
    const stages = ["collect", "inventory", "parse", "map", "validate", "summarize", "finish"];
    const fixture = await makeFixture(1);
    await fixture.configure(revision, stages);
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "seven-stages", "seven-stages");
    const committedSeq = [1, 2, 3, 5, 6, 7, 8];
    for (const [index, stage] of stages.entries()) {
      const final = index === stages.length - 1;
      const observed = await untilStatus(client, runId, final ? "completed" : "interrupted");
      expect(observed).toMatchObject({
        runId, checkpointSeq: committedSeq[index], domainStatus: stage + "-complete", currentStep: stages[index + 1] ?? null,
        lastCompletedStep: { stepKey: stage, generation: index < 3 ? 0 : 1, checkpointSeq: committedSeq[index] },
        nextAction: { action: final ? "results" : "resume" },
      });
      expect(await progress(client, runId)).toMatchObject({
        stage: { phase: observed.status, stepKey: stages[index + 1] ?? null, position: final ? null : index + 2, total: stages.length },
        lastCompletedStep: observed.lastCompletedStep, nextAction: observed.nextAction,
      });
      if (!final) data(await client.call<Status>("workflow_resume", observed.nextAction.arguments));
    }
    const { checkpoints, attempts } = await rerunHistory(fixture, runId);
    expect(checkpoints.filter(c => c.inputChange).map(c => c.checkpointSeq)).toEqual([4]);
    expect(checkpoints.filter(c => c.committed).map(c => c.checkpointSeq)).toEqual(committedSeq);
    expect(attempts.map(a => [a.work.stepKey, a.status])).toEqual(stages.map(stage => [stage, "committed"]));
  }, 60_000);

  it("rejects a tampered committed artifact before invoking the resume factory or input transition hook", async () => {
    const fixture = await makeFixture(1);
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "tampered-request", "generation");
    const paused = await untilStatus(client, runId, "interrupted");
    expect(paused).toMatchObject({ checkpointSeq: 1, generation: 0, currentStep: "prepare-input" });
    const { artifacts } = data(await client.call<Artifacts>("workflow_results", { runId }));
    const artifact = artifacts.find(item => item.kind === "fixture-page");
    assert.ok(artifact);

    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(join(fixture.root, "state", "execution.sqlite"));
    try {
      const { changes } = database.prepare("UPDATE atk_durable_artifacts SET bytes = ? WHERE artifact_id = ?")
        .run(Buffer.from("tampered-page"), artifact.id);
      expect(changes).toBe(1);
    } finally {
      database.close();
    }

    data(await client.call<Status>("workflow_resume", { runId, expectedCheckpointSeq: 1 }));
    expect(await untilStatus(client, runId, "failed")).toMatchObject({
      checkpointSeq: 1, generation: 0, currentStep: "prepare-input", error: { code: "ARTIFACT_MISMATCH" },
    });
    await expect(access(join(fixture.controlDirectory, runId + ".factory-resume"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(join(fixture.controlDirectory, runId + ".prepare-next"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("acknowledges an earlier idempotent start while its registered module is unavailable", async () => {
    const fixture = await makeFixture();
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "earlier-request", "ready");
    await untilStatus(client, runId, "completed");
    const unavailable = fixture.modulePath + ".offline";
    await rename(fixture.modulePath, unavailable);
    try {
      expect(await start(client, "earlier-request", "ready")).toMatchObject({ runId, status: "completed" });
      expect(await client.call("workflow_start", {
        profile: "fixture", idempotencyKey: "new-request", request: { mode: "ready" },
      })).toMatchObject({ isError: true, structuredContent: { code: "PROFILE_MODULE_UNAVAILABLE" } });
    } finally {
      await rename(unavailable, fixture.modulePath);
    }
  }, 60_000);

  it("stores a plugin failure that a new MCP connection can inspect", async () => {
    const fixture = await makeFixture();
    const client = await openClient(fixture.configPath);
    const { runId } = data(await client.call<Status>("workflow_start", {
      profile: "fixture", idempotencyKey: "failed-request", request: { mode: "fail", pauseResumeFactory: true },
    }));
    const failed = await untilStatus(client, runId, "failed");
    expect(failed).toMatchObject({ checkpointSeq: 1, currentStep: "finish", error: { message: "Fixture terminal failure." } });
    expect(await client.disconnect(), client.diagnostics()).toMatchObject({ code: 0 });
    const reconnected = await openClient(fixture.configPath);
    expect(await status(reconnected, runId)).toEqual(failed);
    // This resumed worker exits before taking the durable lease. The previous failure belongs to the older attempt.
    data(await reconnected.call<Status>("workflow_resume", { runId }));
    const { pid } = await workerMarker(fixture, runId, "factory.json");
    killFixtureWorker(pid);
    pausedWorkers.delete(pid);
    expect(await untilResumable(reconnected, runId)).toMatchObject({
      status: "interrupted", error: { code: "WORKER_EXITED" }, checkpointSeq: 1, currentStep: "finish",
    });
  }, 60_000);

  it("keeps the underlying nonrecoverable cause available after reconnect and rejects a repeated resume", async () => {
    const fixture = await makeFixture();
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "source-failure", "source-error");
    const failed = await untilStatus(client, runId, "failed");
    const error = {
      code: "STEP_FAILED", recoverable: false,
      cause: { code: "SOURCE_UNREADABLE", message: "The fixture source is unreadable.", recoverable: false },
    };
    expect(failed).toMatchObject({
      runId, checkpointSeq: 1, currentStep: "finish", lastCompletedStep: { stepKey: "collect", checkpointSeq: 1 },
      error, nextAction: { action: "inspect", tool: null },
    });
    const before = await rerunHistory(fixture, runId);
    expect(await client.disconnect()).toMatchObject({ code: 0 });
    const reconnected = await openClient(fixture.configPath);
    expect(await status(reconnected, runId)).toEqual(failed);
    expect(await reconnected.call("workflow_resume", { runId })).toMatchObject({ isError: true, structuredContent: error });
    expect(await progress(reconnected, runId)).toMatchObject({
      runId, status: "failed", stage: { phase: "failed", stepKey: "finish", position: null, total: null },
      lastCompletedStep: failed.lastCompletedStep, detail: null, error, nextAction: failed.nextAction,
    });
    expect(await rerunHistory(fixture, runId)).toEqual(before);
  }, 60_000);

  it("reruns the selected step of a completed run with new parameters and records its request and effective scope", async () => {
    const fixture = await makeFixture();
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "rerun-request", "ready");
    const original = await untilStatus(client, runId, "completed");
    expect(original).toMatchObject({ checkpointSeq: 2, domainStatus: "verified" });
    const before = data(await client.call<Artifacts>("workflow_results", { runId }));

    const request = {
      runId, expectedCheckpointSeq: 2, stepKey: "finish",
      scope: { sourcePaths: ["/fixture/b.jsp", "/fixture/a.jsp", "/fixture/a.jsp"] },
      params: { label: "changed output" },
    };
    const effectiveScope = { sourcePaths: ["/fixture/a.jsp", "/fixture/b.jsp"], label: "changed output", pause: false };
    expect(data(await client.call<Status>("workflow_rerun", request)).runId).toBe(runId);
    const final = await untilStatus(client, runId, "completed");
    expect(final).toMatchObject({
      runId, checkpointSeq: 4, domainStatus: "rerun-verified", inputSha256: original.inputSha256,
      rerun: { id: expect.any(String), expectedCheckpointSeq: 2, stepKey: "finish", scope: request.scope, params: request.params },
      outcome: { scope: effectiveScope },
    });
    const { checkpoints, attempts } = await rerunHistory(fixture, runId);
    expect(checkpoints.find(item => item.checkpointSeq === 3)).toMatchObject({
      previousCheckpointSeq: 2, rerun: final.rerun, next: { stepKey: "finish", scope: effectiveScope },
    });
    expect(checkpoints.find(item => item.checkpointSeq === 4)).toMatchObject({
      rerun: final.rerun, committed: { stepKey: "finish", scope: effectiveScope }, next: null,
    });
    expect(attempts.map(attempt => attempt.work.stepKey)).toEqual(["collect", "finish", "finish"]);

    const after = data(await client.call<Artifacts>("workflow_results", { runId }));
    expect(after.artifacts).toEqual(expect.arrayContaining(before.artifacts));
    const updated = after.artifacts.find(artifact => artifact.kind === "fixture-rerun");
    assert.ok(updated);
    const chunk = data(await client.call<ArtifactChunk>("workflow_results", { runId, artifactId: updated.id }));
    expect(JSON.parse(Buffer.from(chunk.data, "base64").toString("utf8"))).toEqual({
      sourcePaths: effectiveScope.sourcePaths, label: request.params.label,
    });

    const duplicate = data(await client.call<Status>("workflow_rerun", request));
    expect(duplicate).toMatchObject({ status: "completed", checkpointSeq: 4, rerun: final.rerun });
    expect(await client.call("workflow_rerun", { ...request, params: { label: "stale update" } })).toMatchObject({
      isError: true, structuredContent: { code: "CHECKPOINT_CONFLICT" },
    });

    // Let the trusted plugin reject an unsupported stage without consuming the existing head.
    data(await client.call<Status>("workflow_rerun", { ...request, stepKey: "missing-step", expectedCheckpointSeq: 4 }));
    expect(await untilStatus(client, runId, "failed")).toMatchObject({
      checkpointSeq: 4, error: { code: "FIXTURE_RERUN_INVALID" },
    });
    expect(await rerunHistory(fixture, runId)).toEqual({ checkpoints, attempts });
  }, 60_000);

  it("retries the same request after its external evidence becomes ready without replaying a committed rerun", async () => {
    const fixture = await makeFixture();
    const available = join(fixture.controlDirectory, "evidence-ready");
    await writeFile(fixture.modulePath, `
import { access } from "node:fs/promises";
import { createWorkflow as createBase } from ${JSON.stringify(pathToFileURL(pluginPath).href)};
export async function createWorkflow(context) {
  const plan = await createBase(context);
  return {
    ...plan,
    async planRerun(request) {
      try { await access(${JSON.stringify(available)}); }
      catch { throw Object.assign(new Error("Evidence is not ready."), { code: "FIXTURE_EVIDENCE_NOT_READY" }); }
      return plan.planRerun(request);
    },
  };
}
`, "utf8");
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "rerun-evidence-retry", "ready");
    const initial = await untilStatus(client, runId, "completed");
    const history = await rerunHistory(fixture, runId);
    const request = {
      runId, expectedCheckpointSeq: initial.checkpointSeq, stepKey: "finish",
      scope: { sourcePaths: ["/fixture/page.jsp"] }, params: { label: "evidence arrived" },
    };
    data(await client.call<Status>("workflow_rerun", request));
    const rejected = await untilStatus(client, runId, "failed");
    expect(rejected).toMatchObject({ checkpointSeq: initial.checkpointSeq, error: { code: "FIXTURE_EVIDENCE_NOT_READY" } });
    expect(await rerunHistory(fixture, runId)).toEqual(history);

    await writeFile(available, "ready");
    data(await client.call<Status>("workflow_rerun", request));
    const final = await untilStatus(client, runId, "completed");
    expect(final).toMatchObject({ checkpointSeq: 4, domainStatus: "rerun-verified" });
    expect(final.rerun?.id).not.toBe(rejected.pendingRerun?.id);
    const finalHistory = await rerunHistory(fixture, runId);
    expect(finalHistory.attempts.map(attempt => attempt.work.stepKey)).toEqual(["collect", "finish", "finish"]);
    const duplicate = data(await client.call<Status>("workflow_rerun", request));
    expect(duplicate).toMatchObject({ status: "completed", checkpointSeq: 4, rerun: final.rerun });
    expect(await rerunHistory(fixture, runId)).toEqual(finalHistory);
  }, 60_000);

  it("preserves a scheduled rerun across a worker kill and resumes only its selected work", async () => {
    const fixture = await makeFixture();
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "rerun-crash-request", "ready");
    expect(await untilStatus(client, runId, "completed")).toMatchObject({ checkpointSeq: 2 });

    const request = {
      runId, expectedCheckpointSeq: 2, stepKey: "finish",
      scope: { sourcePaths: ["/fixture/selected.jsp"] },
      params: { label: "restored output", pause: true },
    };
    data(await client.call<Status>("workflow_rerun", request));
    const marker = await pausedMarker(fixture, runId);
    const running = await status(client, runId);
    expect(running).toMatchObject({
      status: "running", checkpointSeq: 3, currentStep: "finish",
      lastCompletedStep: { stepKey: "finish", checkpointSeq: 2, outcome: { code: "verified" } },
      rerun: { expectedCheckpointSeq: 2, stepKey: "finish", scope: request.scope, params: request.params },
    });
    expect(data(await client.call<Status>("workflow_rerun", request))).toMatchObject({
      status: "running", checkpointSeq: 3, rerun: running.rerun,
    });
    expect(await client.call("workflow_rerun", {
      ...request, expectedCheckpointSeq: 3, params: { label: "overlapping" },
    })).toMatchObject({ isError: true, structuredContent: { code: "RUN_ACTIVE" } });

    expect(await client.disconnect(), client.diagnostics()).toMatchObject({ code: 0 });
    killFixtureWorker(marker.pid);
    pausedWorkers.delete(marker.pid);
    const recovered = await openClient(fixture.configPath);
    expect(await untilResumable(recovered, runId)).toMatchObject({
      checkpointSeq: 3, currentStep: "finish", rerun: running.rerun,
      status: "interrupted", worker: { state: "expired" }, error: { code: "WORKER_LEASE_EXPIRED" },
    });
    data(await recovered.call<Status>("workflow_resume", { runId, expectedCheckpointSeq: 3 }));
    expect(await untilStatus(recovered, runId, "completed")).toMatchObject({
      checkpointSeq: 4, domainStatus: "rerun-verified", rerun: running.rerun,
      outcome: { previousAttemptId: marker.attemptId, scope: { sourcePaths: request.scope.sourcePaths, label: request.params.label } },
    });
    const { attempts } = await rerunHistory(fixture, runId);
    expect(attempts.map(item => [item.work.stepKey, item.status])).toEqual([
      ["collect", "committed"], ["finish", "committed"], ["finish", "interrupted"], ["finish", "committed"],
    ]);
    const { artifacts } = data(await recovered.call<Artifacts>("workflow_results", { runId }));
    expect(artifacts.map(item => item.id)).not.toContain(marker.artifactId);
  }, 60_000);

  it("recovers a pending rerun if its worker dies before the rerun checkpoint is written", async () => {
    const fixture = await makeFixture();
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "rerun-planning-crash", "ready");
    expect(await untilStatus(client, runId, "completed")).toMatchObject({ checkpointSeq: 2 });

    const request = {
      runId, expectedCheckpointSeq: 2, stepKey: "finish",
      scope: { sourcePaths: ["/fixture/selected.jsp"] },
      params: { label: "planned again", pausePlanning: true },
    };
    data(await client.call<Status>("workflow_rerun", request));
    const { pid } = await workerMarker(fixture, runId, "planning.json");
    const pending = await status(client, runId);
    expect(pending).toMatchObject({
      status: "running", checkpointSeq: 2, currentStep: "finish",
      pendingRerun: { id: expect.any(String), expectedCheckpointSeq: 2, stepKey: "finish", scope: request.scope, params: request.params },
    });
    expect(await progress(client, runId)).toMatchObject({
      stage: { phase: "preparing", stepKey: "finish" }, detail: null,
    });
    killFixtureWorker(pid);
    pausedWorkers.delete(pid);
    expect(await client.disconnect(), client.diagnostics()).toMatchObject({ code: 0 });

    const recovered = await openClient(fixture.configPath);
    expect(await untilResumable(recovered, runId)).toMatchObject({
      checkpointSeq: 2, pendingRerun: pending.pendingRerun,
    });
    await writeFile(join(fixture.controlDirectory, runId + ".accept-plan"), "");
    data(await recovered.call<Status>("workflow_resume", { runId, expectedCheckpointSeq: 2 }));
    const completed = await untilStatus(recovered, runId, "completed");
    expect(completed).toMatchObject({ checkpointSeq: 4, domainStatus: "rerun-verified", rerun: pending.pendingRerun });
    expect(completed.pendingRerun).toBeUndefined();
    const { checkpoints, attempts } = await rerunHistory(fixture, runId);
    expect(checkpoints.filter(item => item.rerun).map(item => item.checkpointSeq)).toEqual([3, 4]);
    expect(attempts.map(item => item.work.stepKey)).toEqual(["collect", "finish", "finish"]);
  }, 60_000);
});
