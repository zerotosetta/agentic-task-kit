import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { SqliteDurableExecutionStore } from "../src/durable-store.js";
import { SqliteMcpJobStore } from "../src/mcp/job-store.js";
import { SessionStore } from "../src/sessions/store.js";

it("deletes owned history, preserves shared bytes, fences stale launches and replays deletion", async () => {
  const dir = mkdtempSync(join(tmpdir(), "atk-delete-"));
  const config = { jobDatabase: join(dir, "jobs.sqlite"), executionDatabase: join(dir, "execution.sqlite") };
  const runId = randomUUID();
  const sessions = new SessionStore(dir);
  const jobs = new SqliteMcpJobStore(config.jobDatabase);
  const execution = new SqliteDurableExecutionStore(config.executionDatabase, {}, runId);
  const db = new DatabaseSync(config.executionDatabase);
  try {
    const { sessionId } = sessions.create({ title: "target", goal: "goal", idempotencyKey: "a" });
    const neighbor = sessions.create({ title: "other", goal: "goal", idempotencyKey: "b" });
    sessions.note({sessionId, expectedVersion: 1, summary: "updated", nextAction: ""});
    for (const expectedVersion of [0, 1]) {
      sessions.writeFile({sessionId, path: "a", expectedVersion, content: String(expectedVersion)});
    }
    const job = {runId, sessionId, profile: "p", profileFingerprint: "", request: {}, requestFingerprint: "",
      idempotencyKey: "k", token: "t", status: "queued" as const, cancelRequested: false, error: null, rerun: null};
    jobs.start(job, 60000);
    const remove = (expectedVersion = 2) => sessions.delete({sessionId, expectedVersion}, config);
    expect(() => remove(1)).toThrowError(expect.objectContaining({code: "VERSION_CONFLICT"}));
    expect(() => remove()).toThrowError(expect.objectContaining({code: "RUN_ACTIVE"}));
    jobs.cancel(runId);
    const shared = await execution.putArtifact("shared", Uint8Array.of(1));
    const unpublished = await execution.putArtifact("unpublished", Uint8Array.of(2));
    const legacy = randomUUID();
    db.prepare("INSERT INTO atk_durable_artifacts VALUES (?, ?)").run(legacy, Uint8Array.of(3));
    for (const [id, artifacts] of [[runId, [shared, {...shared, id: legacy}]], ["another", [shared]]] as const) {
      db.prepare("INSERT INTO atk_durable_runs(run_id, checkpoint_seq, status) VALUES (?, 0, 'completed')").run(id);
      db.prepare("INSERT INTO atk_durable_checkpoints VALUES (?, 0, ?)").run(id, JSON.stringify({input: {artifacts}}));
    }
    db.prepare("UPDATE atk_durable_runs SET lease_expires_at = ? WHERE run_id = ?").run(Date.now() + 60000, runId);
    expect(() => remove()).toThrowError(expect.objectContaining({code: "RUN_ACTIVE"}));
    db.prepare("UPDATE atk_durable_runs SET lease_expires_at = NULL WHERE run_id = ?").run(runId);
    const nested = join(dir, "runs", runId, "parallel");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "test"), "data");
    expect(remove()).toEqual({sessionId, deleted: true});
    expect(remove()).toEqual({sessionId, deleted: true});
    expect(existsSync(nested)).toBe(false);
    expect(sessions.list()).toEqual([neighbor]);
    expect(() => sessions.create({title: "target", goal: "goal", idempotencyKey: "a"})).toThrowError(expect.objectContaining({code: "SESSION_NOT_FOUND"}));
    await expect(execution.putArtifact("stale", Uint8Array.of(3))).rejects.toThrow("deleted");
    expect(jobs.readBySession(sessionId)).toBeNull();
    expect(() => jobs.start(job, 60000)).toThrowError(expect.objectContaining({code: "SESSION_NOT_FOUND"}));
    expect(await execution.readArtifact(shared.id)).toEqual(Uint8Array.of(1));
    expect(await execution.readArtifact(unpublished.id)).toBeNull();
    expect(await execution.readArtifact(legacy)).toBeNull();
    expect(await execution.readRun(runId)).toBeNull();

    // Simulate a process exiting after the SQLite commit and before removing the directory.
    mkdirSync(nested, {recursive: true});
    const journal = new DatabaseSync(config.jobDatabase);
    try {
      journal.prepare("UPDATE atk_deleted_sessions SET pending_run_id = ? WHERE session_id = ?").run(runId, sessionId);
    } finally { journal.close(); }
    sessions.recoverDeletions(config.jobDatabase);
    expect(existsSync(nested)).toBe(false);
    expect(remove()).toEqual({sessionId, deleted: true});
  } finally {
    db.close();
    execution.close();
    jobs.close();
    sessions.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
