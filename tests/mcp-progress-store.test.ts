import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { profileFingerprint } from "../src/mcp/config.js";
import { SqliteMcpJobStore } from "../src/mcp/job-store.js";
import { runMcpWorker } from "../src/mcp/worker.js";

const job = {
  runId: "id", profile: "fixture", profileFingerprint: "pin", request: {}, requestFingerprint: "request",
  idempotencyKey: "key", token: "first", status: "queued" as const, cancelRequested: false, error: null, rerun: null,
};
const attempt = {
  attemptId: "a", generation: 1, checkpointSeq: 3,
  work: { stepKey: "index", operationKey: "scan", scope: null, cacheFingerprint: "0".repeat(64) },
};
const report = { attemptId: "a", stepKey: "index", item: "한글.jsp", completed: 2, total: 3 };
const exit = { code: "WORKER_EXITED", message: "Worker exited.", recoverable: true };
let directory: string;
let path: string;
let jobs: SqliteMcpJobStore | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "atk-mcp-progress-"));
  path = join(directory, "jobs.sqlite");
});

afterEach(() => {
  vi.restoreAllMocks();
  jobs?.close();
  jobs = undefined;
  rmSync(directory, { recursive: true, force: true });
});

describe("MCP invocation telemetry", () => {
  it("opens legacy jobs, preserving the original request, identity and terminal error", () => {
    const legacy = new DatabaseSync(path);
    try {
      legacy.exec(`
        CREATE TABLE atk_mcp_jobs (
          run_id TEXT PRIMARY KEY, profile TEXT NOT NULL, profile_fingerprint TEXT NOT NULL,
          request_json TEXT NOT NULL, request_fingerprint TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          token TEXT NOT NULL, status TEXT NOT NULL, expires_at INTEGER, cancel_requested INTEGER NOT NULL,
          error_json TEXT, UNIQUE (profile, idempotency_key)
        ) STRICT;
        INSERT INTO atk_mcp_jobs VALUES ('id','fixture','pin','{"mode":"scan"}','request','key','first',
          'failed',NULL,0,'{"code":"OLD_ERROR","message":"Original failure"}');
      `);
    } finally {
      legacy.close();
    }
    jobs = new SqliteMcpJobStore(path);
    expect(jobs.readByKey("fixture", "key")).toMatchObject({
      runId: "id", request: { mode: "scan" }, status: "failed", rerun: null,
      error: { code: "OLD_ERROR", message: "Original failure" }, progress: null, workerPid: null, heartbeatAt: null,
    });
    expect(jobs.queueResume("id", "first", "second", 1000)?.status).toBe("queued");
    expect(jobs.claim("id", "second", 1000)?.workerPid).toBe(process.pid);
  });

  it("renews liveness independently and ignores equivalent snapshots and stale attempts", () => {
    let now = Date.UTC(2026, 0, 1);
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const iso = () => new Date(now).toISOString();
    jobs = new SqliteMcpJobStore(path);
    jobs.start(job, 1000);
    expect(jobs.claim("id", "first", 1000)).toMatchObject({ startedAt: iso(), heartbeatAt: iso(), lastProgressAt: null });
    now += 20;
    jobs.markStep("id", "first", "a");
    expect(jobs.read("id")).toMatchObject({ lastProgressAt: iso(), progress: null });
    now += 20;
    const firstAt = iso();
    jobs.reportProgress("id", "first", attempt, report);
    now += 20;
    jobs.renew("id", "first", 1000);
    jobs.reportProgress("id", "first", attempt, { total: 3, completed: 2, stepKey: "index", item: "한글.jsp", attemptId: "a" });
    expect(jobs.read("id")).toMatchObject({
      heartbeatAt: iso(), lastProgressAt: firstAt, expiresAt: now + 1000,
      progress: { ...report, generation: 1, checkpointSeq: 3, sequence: 1, updatedAt: firstAt },
    });

    jobs.markStep("id", "first", "b");
    jobs.reportProgress("id", "first", attempt, { ...report, item: "stale" });
    expect(jobs.read("id")?.progress).toBeNull();
    jobs.reportProgress("id", "first", { ...attempt, attemptId: "b", checkpointSeq: 4 }, { ...report, attemptId: "b" });
    expect(jobs.read("id")?.progress).toMatchObject({ sequence: 2, checkpointSeq: 4 });
    const lastAt = iso();
    now += 1001;
    jobs.reportProgress("id", "first", { ...attempt, attemptId: "b" }, { ...report, attemptId: "b", item: "expired" });
    expect(jobs.read("id")).toMatchObject({
      status: "interrupted", error: { code: "WORKER_LEASE_EXPIRED", recoverable: true }, progress: { sequence: 2 },
    });
    expect(jobs.queueResume("id", "first", "second", 1000)).toMatchObject({
      progress: null, lastProgressAt: lastAt, heartbeatAt: null, workerPid: null, startedAt: null,
    });
    jobs.claim("id", "second", 1000);
    jobs.markStep("id", "second", "a");
    jobs.reportProgress("id", "first", attempt, report);
    expect(jobs.noteExit("id", "first", exit)).toBe(false);
    expect(jobs.read("id")).toMatchObject({ status: "running", progress: null });
    jobs.reportProgress("id", "second", attempt, report);
    expect(jobs.read("id")?.progress?.sequence).toBe(3);
    expect(jobs.noteExit("id", "second", exit)).toBe(true);
    expect(jobs.read("id")).toMatchObject({ status: "interrupted", error: exit });
  });

  it("rejects invalid reports without losing the previous snapshot", () => {
    jobs = new SqliteMcpJobStore(path);
    jobs.start(job, 1000);
    jobs.claim("id", "first", 1000);
    jobs.markStep("id", "first", "a");
    jobs.reportProgress("id", "first", attempt, report);
    for (const invalid of [
      { stepKey: "other" }, { completed: -1 }, { completed: 1.5 }, { total: NaN },
      { total: Infinity }, { total: Number.MAX_SAFE_INTEGER + 1 }, { completed: 9 },
      { item: "x".repeat(1025) }, { operation: "  " },
    ]) {
      expect(() => jobs!.reportProgress("id", "first", attempt, { ...report, ...invalid })).toThrow();
    }
    expect(jobs.read("id")?.progress).toMatchObject({ ...report, sequence: 1 });
  });

  it("fences delayed callbacks when the next attempt executes the same step", async () => {
    const module = join(directory, "workflow.mjs");
    writeFileSync(module, `
      import { EventEmitter } from "node:events";
      export async function createWorkflow({ store, reportProgress }) {
        const manifest = await store.putArtifact("manifest", new Uint8Array([42]));
        const input = { snapshotId: "input", manifestId: manifest.id, sha256: manifest.sha256, artifacts: [] };
        const first = { stepKey: "index", operationKey: "a", scope: null, cacheFingerprint: manifest.sha256 };
        const events = new EventEmitter();
        const steps = {
          async index({ work, attemptId }) {
            reportProgress({ attemptId, stepKey: "index", item: work.operationKey });
            if (work.operationKey === "a") {
              events.once("late", () => reportProgress({ attemptId, stepKey: "index", item: "stale" }));
              return { outcome: { code: "ok" }, next: { ...first, operationKey: "b" } };
            }
            events.emit("late");
            return { outcome: { code: "ok" }, next: null };
          }
        };
        return { workflow: { workflowKey: "test", revision: "v1", steps }, first, input };
      }
    `);
    const profile = { module, name: "fixture", revision: "v1", settings: {} };
    jobs = new SqliteMcpJobStore(path);
    jobs.start({ ...job, profileFingerprint: profileFingerprint(profile) }, 10_000);
    await runMcpWorker({
      configPath: join(directory, "config.json"), stateDirectory: directory,
      jobDatabase: path, executionDatabase: join(directory, "durable.sqlite"),
      leaseMs: 10_000, queueMs: 10_000, profiles: new Map([["fixture", profile]]),
    }, "id", "first");
    expect(jobs.read("id")).toMatchObject({ status: "completed", progress: { item: "b", sequence: 2 } });
  });
});
