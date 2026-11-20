import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { NormalizedFailure } from "../durable-errors.js";
import { hasText, isRecord } from "../durable-validation.js";
import type { DurableAttempt, DurableJSON, DurableRerun } from "../types/durable.js";
import type { McpWorkflowProgress, McpWorkflowProgressUpdate } from "../types/mcp.js";

export type McpJobStatus = "queued" | "running" | "interrupted" | "cancelled" | "failed" | "completed";
export type McpJobError = NormalizedFailure;

interface NewJob {
  runId: string;
  sessionId?: string | null;
  profile: string;
  profileFingerprint: string;
  stageOrder?: readonly string[] | null;
  request: DurableJSON;
  requestFingerprint: string;
  idempotencyKey: string;
  token: string;
  status: McpJobStatus;
  cancelRequested: boolean;
  error: McpJobError | null;
  rerun: DurableRerun | null;
}

export interface McpJob extends NewJob {
  stageOrder: readonly string[] | null;
  expiresAt: number | null;
  workerPid: number | null;
  startedAt: string | null;
  heartbeatAt: string | null;
  lastProgressAt: string | null;
  progress: McpWorkflowProgress | null;
  /** Attempt reached by this invocation, retained on abnormal exit for error reconciliation. */
  activeAttemptId: string | null;
}

interface JobRow {
  run_id: string;
  session_id: string | null;
  profile: string;
  profile_fingerprint: string;
  stage_order_json: string | null;
  request_json: string;
  request_fingerprint: string;
  idempotency_key: string;
  token: string;
  status: McpJobStatus;
  expires_at: number | null;
  cancel_requested: 0 | 1;
  error_json: string | null;
  rerun_json: string | null;
  worker_pid: number | null;
  started_at: string | null;
  heartbeat_at: string | null;
  last_progress_at: string | null;
  progress_json: string | null;
  active_attempt_id: string | null;
}

type TerminalStatus = Exclude<McpJobStatus, "queued" | "running">;

const requireBuiltin = createRequire(import.meta.url);

// These columns are also added to databases created by earlier releases.
const jobColumns = {
  session_id: "TEXT",
  stage_order_json: "TEXT",
  rerun_json: "TEXT",
  worker_pid: "INTEGER",
  started_at: "TEXT",
  heartbeat_at: "TEXT",
  last_progress_at: "TEXT",
  progress_json: "TEXT",
  progress_seq: "INTEGER NOT NULL DEFAULT 0",
  active_attempt_id: "TEXT",
};

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
    ${Object.entries(jobColumns).map(([name, definition]) => name + " " + definition).join(",\n    ")},
    UNIQUE (profile, idempotency_key)
  ) STRICT;
`;

function decode(row: JobRow, now: number): McpJob {
  const cancelRequested = row.cancel_requested === 1;
  const expired = (row.status === "queued" || row.status === "running") && (row.expires_at ?? 0) <= now;
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    profile: row.profile,
    profileFingerprint: row.profile_fingerprint,
    stageOrder: row.stage_order_json === null ? null : JSON.parse(row.stage_order_json) as readonly string[],
    request: JSON.parse(row.request_json) as DurableJSON,
    requestFingerprint: row.request_fingerprint,
    idempotencyKey: row.idempotency_key,
    token: row.token,
    status: expired ? (cancelRequested ? "cancelled" : "interrupted") : row.status,
    cancelRequested,
    error: expired && !cancelRequested ? {
      code: "WORKER_LEASE_EXPIRED",
      message: "The workflow launch or worker lease expired before the invocation finished.",
      recoverable: true,
    } : row.error_json === null ? null : JSON.parse(row.error_json) as McpJobError,
    rerun: row.rerun_json === null ? null : JSON.parse(row.rerun_json) as DurableRerun,
    expiresAt: row.expires_at,
    workerPid: row.worker_pid,
    startedAt: row.started_at,
    heartbeatAt: row.heartbeat_at,
    lastProgressAt: row.last_progress_at,
    progress: row.progress_json === null ? null : JSON.parse(row.progress_json) as McpWorkflowProgress,
    activeAttemptId: row.active_attempt_id,
  };
}

const textLimits = { attemptId: 128, stepKey: 256, operation: 256, unit: 64, item: 1024, message: 1024 } as const;

function progressPayload(update: McpWorkflowProgressUpdate, stepKey: string): string {
  if (!isRecord(update) || update.stepKey !== stepKey) {
    throw new TypeError("Progress must identify the executing step.");
  }
  // Copy supported scalar fields in a stable order for snapshot deduplication.
  const payload: Record<string, string | number> = {};
  for (const [field, limit] of Object.entries(textLimits)) {
    const value = update[field];
    if (value === undefined) continue;
    if (!hasText(value) || value.length > limit) {
      throw new TypeError(`Progress ${field} must be non-empty text of at most ${limit} characters.`);
    }
    payload[field] = value;
  }
  for (const field of ["completed", "total"] as const) {
    const value = update[field];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`Progress ${field} must be a nonnegative safe integer.`);
    }
    payload[field] = value;
  }
  if (update.completed !== undefined && update.total !== undefined && update.completed > update.total) {
    throw new RangeError("Progress completed exceeds total.");
  }
  return JSON.stringify(payload);
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
        const existing = new Set(this.database.prepare("PRAGMA table_info(atk_mcp_jobs)").all().map(row => row.name));
        for (const [name, definition] of Object.entries(jobColumns)) {
          if (!existing.has(name)) this.database.exec(`ALTER TABLE atk_mcp_jobs ADD COLUMN ${name} ${definition}`);
        }
        this.database.exec("CREATE UNIQUE INDEX IF NOT EXISTS atk_job_session ON atk_mcp_jobs(session_id) WHERE session_id IS NOT NULL");
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

  readBySession(sessionId: string): McpJob | null {
    const row = this.database.prepare("SELECT * FROM atk_mcp_jobs WHERE session_id = ?").get(sessionId) as JobRow | undefined;
    return row ? decode(row, Date.now()) : null;
  }

  start(job: NewJob, queueMs: number): { job: McpJob; created: boolean } {
    return this.transaction((now) => {
      const inserted = this.database.prepare(`
        INSERT INTO atk_mcp_jobs (
          run_id, profile, profile_fingerprint, request_json, request_fingerprint, idempotency_key, token,
          status, expires_at, stage_order_json, session_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)
        ON CONFLICT DO NOTHING
        RETURNING *
      `).get(
        job.runId, job.profile, job.profileFingerprint, JSON.stringify(job.request), job.requestFingerprint,
        job.idempotencyKey, job.token, expiration(now, queueMs),
        job.stageOrder == null ? null : JSON.stringify(job.stageOrder), job.sessionId ?? null,
      ) as JobRow | undefined;
      if (inserted) return { job: decode(inserted, now), created: true };

      if (job.sessionId) {
        const prior = this.readBySession(job.sessionId);
        if (prior) return { job: prior, created: false };
      }

      const prior = this.database.prepare("SELECT * FROM atk_mcp_jobs WHERE profile = ? AND idempotency_key = ?")
        .get(job.profile, job.idempotencyKey) as JobRow | undefined;
      if (!prior) throw new Error("The existing MCP job could not be loaded.");
      return { job: decode(prior, now), created: false };
    });
  }

  claim(runId: string, token: string, leaseMs: number): McpJob | null {
    return this.transaction((now) => {
      const row = this.database.prepare(`
        UPDATE atk_mcp_jobs SET status = 'running', expires_at = ?, worker_pid = ?, started_at = ?, heartbeat_at = ?
        WHERE run_id = ? AND status = 'queued' AND token = ? AND expires_at > ?
        RETURNING *
      `).get(expiration(now, leaseMs), process.pid, new Date(now).toISOString(), new Date(now).toISOString(),
        runId, token, now) as JobRow | undefined;
      return row ? decode(row, now) : null;
    });
  }

  renew(runId: string, token: string, leaseMs: number): McpJob | null {
    return this.transaction((now) => {
      const row = this.database.prepare(`
        UPDATE atk_mcp_jobs SET expires_at = ?, heartbeat_at = ?
        WHERE run_id = ? AND status = 'running' AND token = ? AND expires_at > ?
        RETURNING *
      `).get(expiration(now, leaseMs), new Date(now).toISOString(), runId, token, now) as JobRow | undefined;
      return row ? decode(row, now) : null;
    });
  }

  pinStageOrder(runId: string, token: string, stages: readonly string[]): void {
    this.transaction(now => {
      this.database.prepare(`
        UPDATE atk_mcp_jobs SET stage_order_json = ?
        WHERE run_id = ? AND token = ? AND stage_order_json IS NULL AND status = 'running' AND expires_at > ?
      `).run(JSON.stringify(stages), runId, token, now);
    });
  }

  /** A successful attempt start or checkpoint commit is itself observable work. */
  markStep(runId: string, token: string, activeAttemptId: string | null, retainProgress = false): void {
    this.transaction(now => {
      this.database.prepare(`
        UPDATE atk_mcp_jobs SET last_progress_at = ?, active_attempt_id = ?,
          progress_json = CASE WHEN ? THEN progress_json END
        WHERE run_id = ? AND token = ? AND status = 'running' AND expires_at > ?
      `).run(new Date(now).toISOString(), activeAttemptId, Number(retainProgress), runId, token, now);
    });
  }

  reportProgress(
    runId: string, token: string,
    attempt: Pick<DurableAttempt, "attemptId" | "work" | "generation" | "checkpointSeq">,
    update: McpWorkflowProgressUpdate,
  ): void {
    if (update?.attemptId !== attempt.attemptId) return;
    const payload = progressPayload(update, attempt.work.stepKey);
    this.transaction(now => {
      const at = new Date(now).toISOString();
      this.database.prepare(`
        UPDATE atk_mcp_jobs SET progress_seq = progress_seq + 1, last_progress_at = ?,
          progress_json = json_set(?, '$.sequence', progress_seq + 1, '$.updatedAt', ?,
            '$.generation', ?, '$.checkpointSeq', ?)
        WHERE run_id = ? AND token = ? AND active_attempt_id = ?
          AND status = 'running' AND expires_at > ? AND cancel_requested = 0
          AND json_remove(progress_json, '$.sequence', '$.updatedAt', '$.generation', '$.checkpointSeq') IS NOT ?
      `).run(at, payload, at, attempt.generation, attempt.checkpointSeq, runId, token, attempt.attemptId, now, payload);
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
          rerun_json = COALESCE(?, rerun_json), worker_pid = NULL, started_at = NULL, heartbeat_at = NULL,
          progress_json = NULL, active_attempt_id = NULL
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

  /** The launching process observed this child exit without publishing a terminal result. */
  noteExit(runId: string, token: string, error: McpJobError): boolean {
    return this.transaction(() => {
      const { changes } = this.database.prepare(`
        UPDATE atk_mcp_jobs SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'interrupted' END,
          expires_at = NULL, error_json = CASE WHEN cancel_requested = 0 THEN ? END
        WHERE run_id = ? AND token = ? AND status IN ('queued', 'running')
      `).run(JSON.stringify(error), runId, token);
      return changes === 1;
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
        UPDATE atk_mcp_jobs SET status = ?, expires_at = NULL, active_attempt_id = NULL, error_json = ?
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
