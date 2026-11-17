import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DurableJSON, DurableRerun } from "../types/durable.js";

export type McpJobStatus = "queued" | "running" | "interrupted" | "cancelled" | "failed" | "completed";
export type McpJobError = { code: string; message: string };

export interface McpJob {
  runId: string;
  profile: string;
  profileFingerprint: string;
  request: DurableJSON;
  requestFingerprint: string;
  idempotencyKey: string;
  token: string;
  status: McpJobStatus;
  cancelRequested: boolean;
  error: McpJobError | null;
  rerun: DurableRerun | null;
}

interface JobRow {
  run_id: string;
  profile: string;
  profile_fingerprint: string;
  request_json: string;
  request_fingerprint: string;
  idempotency_key: string;
  token: string;
  status: McpJobStatus;
  expires_at: number | null;
  cancel_requested: 0 | 1;
  error_json: string | null;
  rerun_json: string | null;
}

type TerminalStatus = Exclude<McpJobStatus, "queued" | "running">;

const requireBuiltin = createRequire(import.meta.url);

const schema = `
  CREATE TABLE IF NOT EXISTS atk_mcp_jobs (
    run_id TEXT PRIMARY KEY,
    profile TEXT NOT NULL,
    profile_fingerprint TEXT NOT NULL,
    request_json TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    token TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'interrupted', 'cancelled', 'failed', 'completed')),
    expires_at INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
    error_json TEXT,
    rerun_json TEXT,
    UNIQUE (profile, idempotency_key)
  ) STRICT;
`;

function decode(row: JobRow, now: number): McpJob {
  const cancelRequested = row.cancel_requested === 1;
  const expired = (row.status === "queued" || row.status === "running") && (row.expires_at ?? 0) <= now;
  return {
    runId: row.run_id,
    profile: row.profile,
    profileFingerprint: row.profile_fingerprint,
    request: JSON.parse(row.request_json) as DurableJSON,
    requestFingerprint: row.request_fingerprint,
    idempotencyKey: row.idempotency_key,
    token: row.token,
    status: expired ? (cancelRequested ? "cancelled" : "interrupted") : row.status,
    cancelRequested,
    error: row.error_json === null ? null : JSON.parse(row.error_json) as McpJobError,
    rerun: row.rerun_json === null ? null : JSON.parse(row.rerun_json) as DurableRerun,
  };
}

function expiration(now: number, durationMs: number): number {
  const expires = now + durationMs;
  if (!Number.isSafeInteger(durationMs) || durationMs <= 0 || !Number.isSafeInteger(expires)) {
    throw new RangeError("Job lease duration must be a positive safe number of milliseconds.");
  }
  return expires;
}

/** Coordinates MCP jobs and launch tokens across server and worker processes. */
export class SqliteMcpJobStore {
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    if (!databasePath || databasePath === ":memory:") {
      throw new TypeError("A persistent SQLite job database file path is required.");
    }
    let sqlite: typeof import("node:sqlite");
    try {
      sqlite = requireBuiltin("node:sqlite") as typeof import("node:sqlite");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ERR_UNKNOWN_BUILTIN_MODULE") throw error;
      throw new Error("SQLite requires --experimental-sqlite on Node.js 22.12 or Node.js 22.13+.", { cause: error });
    }
    const path = resolve(databasePath);
    mkdirSync(dirname(path), { recursive: true });
    this.database = new sqlite.DatabaseSync(path);
    try {
      this.database.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL;");
      this.transaction(() => {
        this.database.exec(schema);
        if (!this.database.prepare("SELECT 1 FROM pragma_table_info('atk_mcp_jobs') WHERE name = 'rerun_json'").get()) {
          this.database.exec("ALTER TABLE atk_mcp_jobs ADD COLUMN rerun_json TEXT");
        }
      });
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  read(runId: string): McpJob | null {
    const row = this.database.prepare("SELECT * FROM atk_mcp_jobs WHERE run_id = ?").get(runId) as JobRow | undefined;
    return row ? decode(row, Date.now()) : null;
  }

  readByKey(profile: string, idempotencyKey: string): McpJob | null {
    const row = this.database.prepare("SELECT * FROM atk_mcp_jobs WHERE profile = ? AND idempotency_key = ?")
      .get(profile, idempotencyKey) as JobRow | undefined;
    return row ? decode(row, Date.now()) : null;
  }

  start(job: McpJob, queueMs: number): { job: McpJob; created: boolean } {
    return this.transaction((now) => {
      const inserted = this.database.prepare(`
        INSERT INTO atk_mcp_jobs (
          run_id, profile, profile_fingerprint, request_json, request_fingerprint, idempotency_key, token,
          status, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?)
        ON CONFLICT (profile, idempotency_key) DO NOTHING
        RETURNING *
      `).get(
        job.runId, job.profile, job.profileFingerprint, JSON.stringify(job.request), job.requestFingerprint,
        job.idempotencyKey, job.token, expiration(now, queueMs),
      ) as JobRow | undefined;
      if (inserted) return { job: decode(inserted, now), created: true };

      const prior = this.database.prepare("SELECT * FROM atk_mcp_jobs WHERE profile = ? AND idempotency_key = ?")
        .get(job.profile, job.idempotencyKey) as JobRow | undefined;
      if (!prior) throw new Error("The existing MCP job could not be loaded.");
      return { job: decode(prior, now), created: false };
    });
  }

  claim(runId: string, token: string, leaseMs: number): McpJob | null {
    return this.transaction((now) => {
      const row = this.database.prepare(`
        UPDATE atk_mcp_jobs SET status = 'running', expires_at = ?
        WHERE run_id = ? AND status = 'queued' AND token = ? AND expires_at > ?
        RETURNING *
      `).get(expiration(now, leaseMs), runId, token, now) as JobRow | undefined;
      return row ? decode(row, now) : null;
    });
  }

  renew(runId: string, token: string, leaseMs: number): McpJob | null {
    return this.transaction((now) => {
      const row = this.database.prepare(`
        UPDATE atk_mcp_jobs SET expires_at = ?
        WHERE run_id = ? AND status = 'running' AND token = ? AND expires_at > ?
        RETURNING *
      `).get(expiration(now, leaseMs), runId, token, now) as JobRow | undefined;
      return row ? decode(row, now) : null;
    });
  }

  queueResume(runId: string, previousToken: string, newToken: string, queueMs: number): McpJob | null {
    return this.queueExisting(runId, previousToken, newToken, queueMs, null);
  }

  queueRerun(runId: string, previousToken: string, newToken: string, queueMs: number, rerun: DurableRerun): McpJob | null {
    return this.queueExisting(runId, previousToken, newToken, queueMs, rerun);
  }

  private queueExisting(
    runId: string,
    previousToken: string,
    newToken: string,
    queueMs: number,
    rerun: DurableRerun | null,
  ): McpJob | null {
    return this.transaction((now) => {
      const row = this.database.prepare(`
        UPDATE atk_mcp_jobs
        SET status = 'queued', token = ?, expires_at = ?, cancel_requested = 0, error_json = NULL,
          rerun_json = COALESCE(?, rerun_json)
        WHERE run_id = ? AND token = ? AND (
          status IN ('interrupted', 'failed', 'cancelled')
          OR (? IS NOT NULL AND status = 'completed')
          OR (status IN ('queued', 'running') AND expires_at <= ?)
        )
        RETURNING *
      `).get(newToken, expiration(now, queueMs), rerun && JSON.stringify(rerun),
        runId, previousToken, rerun?.id ?? null, now) as JobRow | undefined;
      return row ? decode(row, now) : null;
    });
  }

  cancel(runId: string): McpJob | null {
    return this.transaction((now) => {
      const row = this.database.prepare(`
        UPDATE atk_mcp_jobs SET
          status = CASE WHEN status = 'running' AND expires_at > ? THEN 'running' ELSE 'cancelled' END,
          expires_at = CASE WHEN status = 'running' AND expires_at > ? THEN expires_at END,
          cancel_requested = 1
        WHERE run_id = ? AND status IN ('queued', 'running', 'interrupted')
        RETURNING *
      `).get(now, now, runId) as JobRow | undefined;
      return row ? decode(row, now) : this.read(runId);
    });
  }

  finish(runId: string, token: string, status: TerminalStatus, error: McpJobError | null): boolean {
    return this.transaction((now) => {
      const { changes } = this.database.prepare(`
        UPDATE atk_mcp_jobs SET status = ?, expires_at = NULL, error_json = ?
        WHERE run_id = ? AND token = ? AND expires_at > ?
          AND (status = 'running' OR (status = 'queued' AND ? = 'failed'))
      `).run(status, error === null ? null : JSON.stringify(error), runId, token, now, status);
      return changes === 1;
    });
  }

  private transaction<T>(operation: (now: number) => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation(Date.now());
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // SQLite may already have rolled back after a storage failure.
      }
      throw error;
    }
  }
}
