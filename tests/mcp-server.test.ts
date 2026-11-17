import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { evidenceBytes } from "./fixtures/mcp-workflow.js";
import type { McpWorkflowStatus as Status } from "../src/types/mcp.js";

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

async function openClient(configPath: string) {
  const client = connect(configPath);
  clients.push(client);
  const handshake = await client.request<{ protocolVersion: string }>("initialize", {
    protocolVersion: "2025-06-18",
    clientInfo: { name: "atk-test-client", version: "1" },
    capabilities: {},
  });
  expect(handshake.protocolVersion).toBe("2025-06-18");
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
  async function configure(version = revision) {
    await writeFile(configPath, JSON.stringify({
      stateDirectory: "./state",
      leaseMs: 3_000,
      profiles: { fixture: {
        module: "./workflow.mjs",
        revision: version,
        settings: { controlDirectory },
        ...(maxSteps === undefined ? {} : { maxSteps }),
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

async function untilStatus(client: Client, runId: string, desired: Status["status"]) {
  let observed: Status | undefined;
  await expect.poll(async () => {
    observed = await status(client, runId);
    return observed;
  }, { timeout: 20_000, interval: 100 }).toMatchObject({ status: desired });
  assert.ok(observed);
  return observed;
}

async function pausedMarker(fixture: Fixture, runId: string) {
  let marker: Marker | undefined;
  await expect.poll(async () => {
    try {
      marker = JSON.parse(await readFile(join(fixture.controlDirectory, runId + ".paused.json"), "utf8")) as Marker;
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

describe("ATK stdio MCP durable worker", () => {
  it("keeps working across a client disconnect, deduplicates start and pages committed bytes", async () => {
    const fixture = await makeFixture();
    const client = await openClient(fixture.configPath);
    const listed = await client.request<{ tools: Array<{ name: string }> }>("tools/list", {});
    expect(listed.tools.map(tool => tool.name).sort()).toEqual([
      "workflow_cancel", "workflow_results", "workflow_resume", "workflow_start", "workflow_status",
    ]);

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
    const initialResults = data(await client.call<Artifacts>("workflow_results", { runId }));
    expect(initialResults.artifacts.map(artifact => artifact.kind)).toEqual(["fixture-page"]);
    expect((await client.call("workflow_results", { runId, artifactId: marker.artifactId })).isError).toBe(true);

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
    expect(await client.disconnect(), client.diagnostics()).toMatchObject({ code: 0 });

    const reconnected = await openClient(fixture.configPath);
    const interrupted = await untilStatus(reconnected, runId, "interrupted");
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
    expect((await client.call("workflow_results", { runId, artifactId: marker.artifactId })).isError).toBe(true);
    data(await client.call<Status>("workflow_resume", { runId, expectedCheckpointSeq: 1 }));
    expect(await untilStatus(client, runId, "completed")).toMatchObject({
      checkpointSeq: 2, outcome: { previousAttemptId: marker.attemptId },
    });
  }, 60_000);

  it("applies a plugin's checkpoint-driven input generation transition before its next work", async () => {
    const fixture = await makeFixture(1);
    const client = await openClient(fixture.configPath);
    const { runId } = await start(client, "generation-request", "generation");
    const paused = await untilStatus(client, runId, "interrupted");
    expect(paused).toMatchObject({ checkpointSeq: 1, generation: 0, currentStep: "prepare-input" });
    expect(await client.disconnect(), client.diagnostics()).toMatchObject({ code: 0 });
    const reconnected = await openClient(fixture.configPath);
    data(await reconnected.call<Status>("workflow_resume", { runId, expectedCheckpointSeq: 1 }));
    expect(await untilStatus(reconnected, runId, "completed")).toMatchObject({
      checkpointSeq: 3, generation: 1, domainStatus: "generation-checked",
      outcome: { generation: 1, original: "page-one" },
    });
    await expect(access(join(fixture.controlDirectory, runId + ".factory-resume"))).resolves.toBeUndefined();
    await expect(access(join(fixture.controlDirectory, runId + ".prepare-next"))).resolves.toBeUndefined();
    const { artifacts } = data(await reconnected.call<Artifacts>("workflow_results", { runId }));
    expect(artifacts.map(artifact => artifact.kind)).toContain("fixture-page");
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
    const { runId } = await start(client, "failed-request", "fail");
    const failed = await untilStatus(client, runId, "failed");
    expect(failed).toMatchObject({ checkpointSeq: 1, currentStep: "finish", error: { message: "Fixture terminal failure." } });
    expect(await client.disconnect(), client.diagnostics()).toMatchObject({ code: 0 });
    const reconnected = await openClient(fixture.configPath);
    expect(await status(reconnected, runId)).toEqual(failed);
  }, 60_000);
});
