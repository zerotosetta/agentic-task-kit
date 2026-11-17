import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { sha256 } from "./durable-validation.js";
import type {
  DurableArtifactRef,
  DurableAttempt,
  DurableCheckpoint,
  DurableErrorDetails,
  DurableExecutionStore,
  DurableRunResult,
  DurableStatus,
  DurableWork,
} from "./types/durable.js";

const requireBuiltin = createRequire(import.meta.url);

const schema = `
  CREATE TABLE IF NOT EXISTS atk_durable_runs (
    run_id TEXT PRIMARY KEY,
    checkpoint_seq INTEGER NOT NULL,
    status TEXT NOT NULL,
    error_json TEXT,
    lease_owner TEXT,
    lease_expires_at INTEGER,
    active_attempt_id TEXT
  );
  CREATE TABLE IF NOT EXISTS atk_durable_checkpoints (
    run_id TEXT NOT NULL REFERENCES atk_durable_runs (run_id),
    checkpoint_seq INTEGER NOT NULL,
    checkpoint_json TEXT NOT NULL,
    PRIMARY KEY (run_id, checkpoint_seq)
  );
  CREATE TABLE IF NOT EXISTS atk_durable_attempts (
    attempt_order INTEGER PRIMARY KEY,
    attempt_id TEXT NOT NULL UNIQUE,
    run_id TEXT NOT NULL REFERENCES atk_durable_runs (run_id),
    previous_attempt_id TEXT,
    generation INTEGER NOT NULL,
    operation_key TEXT NOT NULL,
    checkpoint_seq INTEGER NOT NULL,
    committed_checkpoint_seq INTEGER,
    work_json TEXT NOT NULL,
    status TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS atk_durable_attempts_operation
    ON atk_durable_attempts (run_id, generation, operation_key, attempt_order);
  CREATE TABLE IF NOT EXISTS atk_durable_artifacts (
    artifact_id TEXT PRIMARY KEY,
    bytes BLOB NOT NULL
  );
`;

interface RunHead {
  checkpoint_seq: number;
  active_attempt_id: string | null;
}

interface RunRow {
  status: DurableStatus;
  error_json: string | null;
  lease_expires_at: number | null;
  checkpoint_json: string;
}

interface AttemptRow {
  attempt_id: string;
  previous_attempt_id: string | null;
  generation: number;
  checkpoint_seq: number;
  committed_checkpoint_seq: number | null;
  work_json: string;
  status: DurableAttempt["status"];
  lease_expires_at: number | null;
}

/** A local SQLite store with transactional checkpoint publication and expiring execution leases. */
export class SqliteDurableExecutionStore implements DurableExecutionStore {
  readonly leaseMs: number;
  private readonly database: DatabaseSync;

  constructor(databasePath: string, { leaseMs = 30_000 }: { leaseMs?: number } = {}) {
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 2_147_483_647) {
      throw new RangeError("leaseMs must be a positive integer within Node's timer range.");
    }
    if (!databasePath || databasePath === ":memory:") {
      throw new TypeError("A persistent SQLite database file path is required.");
    }
    this.leaseMs = leaseMs;
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
      this.transaction(() => this.database.exec(schema));
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  close(): void {
    this.database.close();
  }

  async createRun(checkpoint: DurableCheckpoint): Promise<boolean> {
    return this.transaction(() => {
      const { changes } = this.database.prepare(`
        INSERT INTO atk_durable_runs (run_id, checkpoint_seq, status) VALUES (?, ?, ?)
        ON CONFLICT (run_id) DO NOTHING
      `).run(checkpoint.runId, checkpoint.checkpointSeq, checkpoint.next === null ? "completed" : "running");
      if (changes === 0) return false;
      this.insertCheckpoint(checkpoint);
      return true;
    });
  }

  async readRun(runId: string): Promise<DurableRunResult | null> {
    const row = this.database.prepare(`
      SELECT r.status, r.error_json, r.lease_expires_at, c.checkpoint_json
      FROM atk_durable_runs r JOIN atk_durable_checkpoints c USING (run_id, checkpoint_seq)
      WHERE r.run_id = ?
    `).get(runId) as RunRow | undefined;
    if (!row) return null;
    const status = row.status === "running" && (row.lease_expires_at ?? 0) <= Date.now()
      ? "interrupted"
      : row.status;
    return {
      runId,
      status,
      checkpoint: JSON.parse(row.checkpoint_json) as DurableCheckpoint,
      error: row.error_json === null ? null : JSON.parse(row.error_json) as DurableErrorDetails,
    };
  }

  async readCheckpoint(runId: string, checkpointSeq: number): Promise<DurableCheckpoint | null> {
    const row = this.database.prepare(`
      SELECT checkpoint_json FROM atk_durable_checkpoints WHERE run_id = ? AND checkpoint_seq = ?
    `).get(runId, checkpointSeq);
    return row ? JSON.parse(row.checkpoint_json as string) as DurableCheckpoint : null;
  }

  async listCheckpoints(runId: string): Promise<readonly DurableCheckpoint[]> {
    return this.database.prepare(`
      SELECT checkpoint_json FROM atk_durable_checkpoints WHERE run_id = ? ORDER BY checkpoint_seq
    `).all(runId).map((row) => JSON.parse(row.checkpoint_json as string) as DurableCheckpoint);
  }

  async listAttempts(runId: string): Promise<readonly DurableAttempt[]> {
    const rows = this.database.prepare(`
      SELECT a.*, r.lease_expires_at
      FROM atk_durable_attempts a JOIN atk_durable_runs r USING (run_id)
      WHERE a.run_id = ? ORDER BY a.attempt_order
    `).all(runId) as unknown as AttemptRow[];
    const now = Date.now();
    return rows.map((row) => ({
      attemptId: row.attempt_id,
      previousAttemptId: row.previous_attempt_id,
      generation: row.generation,
      checkpointSeq: row.checkpoint_seq,
      committedCheckpointSeq: row.committed_checkpoint_seq,
      work: JSON.parse(row.work_json) as DurableWork,
      status: row.status === "started" && (row.lease_expires_at ?? 0) <= now ? "interrupted" : row.status,
    }));
  }

  async acquire(runId: string, expectedSeq: number, owner: string): Promise<boolean> {
    return this.transaction(() => {
      const now = Date.now();
      const row = this.database.prepare(`
        SELECT active_attempt_id FROM atk_durable_runs
        WHERE run_id = ? AND checkpoint_seq = ? AND (lease_owner IS NULL OR lease_expires_at <= ?)
      `).get(runId, expectedSeq, now) as Pick<RunHead, "active_attempt_id"> | undefined;
      if (!row) return false;
      this.updateAttemptStatus(runId, row.active_attempt_id, "interrupted");
      this.database.prepare(`
        UPDATE atk_durable_runs
        SET lease_owner = ?, lease_expires_at = ?, active_attempt_id = NULL, error_json = NULL,
            status = CASE WHEN status = 'completed' THEN 'completed' ELSE 'running' END
        WHERE run_id = ?
      `).run(owner, now + this.leaseMs, runId);
      return true;
    });
  }

  async renew(runId: string, owner: string): Promise<boolean> {
    return this.transaction(() => {
      const now = Date.now();
      const { changes } = this.database.prepare(`
        UPDATE atk_durable_runs SET lease_expires_at = ?
        WHERE run_id = ? AND lease_owner = ? AND lease_expires_at > ?
      `).run(now + this.leaseMs, runId, owner, now);
      return changes === 1;
    });
  }

  async release(runId: string, owner: string): Promise<void> {
    this.database.prepare(`
      UPDATE atk_durable_runs SET lease_owner = NULL, lease_expires_at = NULL
      WHERE run_id = ? AND lease_owner = ?
    `).run(runId, owner);
  }

  async beginAttempt(runId: string, owner: string, attempt: DurableAttempt): Promise<DurableAttempt | null> {
    return this.transaction(() => {
      const head = this.ownedHead(runId, owner);
      if (!head || head.checkpoint_seq !== attempt.checkpointSeq || head.active_attempt_id !== null) return null;
      const previous = this.database.prepare(`
        SELECT attempt_id FROM atk_durable_attempts
        WHERE run_id = ? AND generation = ? AND operation_key = ?
        ORDER BY attempt_order DESC LIMIT 1
      `).get(runId, attempt.generation, attempt.work.operationKey) as Pick<AttemptRow, "attempt_id"> | undefined;
      const previousAttemptId = previous?.attempt_id ?? null;
      this.database.prepare(`
        INSERT INTO atk_durable_attempts (
          attempt_id, run_id, previous_attempt_id, generation, operation_key, checkpoint_seq, work_json, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'started')
      `).run(
        attempt.attemptId, runId, previousAttemptId, attempt.generation, attempt.work.operationKey,
        attempt.checkpointSeq, JSON.stringify(attempt.work),
      );
      this.database.prepare("UPDATE atk_durable_runs SET active_attempt_id = ? WHERE run_id = ?")
        .run(attempt.attemptId, runId);
      return { ...attempt, previousAttemptId, status: "started", committedCheckpointSeq: null };
    });
  }

  async commit(checkpoint: DurableCheckpoint, owner: string): Promise<boolean> {
    return this.transaction(() => {
      const head = this.ownedHead(checkpoint.runId, owner);
      if (!head || head.checkpoint_seq !== checkpoint.previousCheckpointSeq ||
          checkpoint.checkpointSeq !== head.checkpoint_seq + 1 ||
          head.active_attempt_id !== (checkpoint.committed?.attemptId ?? null)) return false;
      this.insertCheckpoint(checkpoint);
      this.updateAttemptStatus(checkpoint.runId, head.active_attempt_id, "committed", checkpoint.checkpointSeq);
      this.database.prepare(`
        UPDATE atk_durable_runs SET checkpoint_seq = ?, status = ?, active_attempt_id = NULL, error_json = NULL
        WHERE run_id = ?
      `).run(checkpoint.checkpointSeq, checkpoint.next === null ? "completed" : "running", checkpoint.runId);
      return true;
    });
  }

  async stop(
    runId: string,
    owner: string,
    status: "cancelled" | "failed",
    error: DurableErrorDetails,
  ): Promise<boolean> {
    return this.transaction(() => {
      const head = this.ownedHead(runId, owner);
      if (!head || head.checkpoint_seq !== error.checkpointSeq || error.runId !== runId) return false;
      this.updateAttemptStatus(runId, head.active_attempt_id, status);
      this.database.prepare(`
        UPDATE atk_durable_runs SET status = ?, active_attempt_id = NULL, error_json = ? WHERE run_id = ?
      `).run(status, JSON.stringify(error), runId);
      return true;
    });
  }

  async putArtifact(kind: string, bytes: Uint8Array): Promise<DurableArtifactRef> {
    const copy = new Uint8Array(bytes);
    const id = randomUUID();
    const digest = sha256(copy);
    this.database.prepare("INSERT INTO atk_durable_artifacts (artifact_id, bytes) VALUES (?, ?)").run(id, copy);
    return { kind, id, sha256: digest };
  }

  async readArtifact(id: string): Promise<Uint8Array | null> {
    const row = this.database.prepare("SELECT bytes FROM atk_durable_artifacts WHERE artifact_id = ?").get(id);
    return row ? row.bytes as Uint8Array : null;
  }

  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE;");
    try {
      const result = operation();
      this.database.exec("COMMIT;");
      return result;
    } catch (error) {
      try {
        this.database.exec("ROLLBACK;");
      } catch {
        // SQLite can already have rolled back a transaction after a storage failure.
      }
      throw error;
    }
  }

  private ownedHead(runId: string, owner: string): RunHead | undefined {
    return this.database.prepare(`
      SELECT checkpoint_seq, active_attempt_id FROM atk_durable_runs
      WHERE run_id = ? AND lease_owner = ? AND lease_expires_at > ?
    `).get(runId, owner, Date.now()) as RunHead | undefined;
  }

  private insertCheckpoint(checkpoint: DurableCheckpoint): void {
    this.database.prepare(`
      INSERT INTO atk_durable_checkpoints (run_id, checkpoint_seq, checkpoint_json) VALUES (?, ?, ?)
    `).run(checkpoint.runId, checkpoint.checkpointSeq, JSON.stringify(checkpoint));
  }

  private updateAttemptStatus(
    runId: string,
    attemptId: string | null,
    status: Exclude<DurableAttempt["status"], "started">,
    checkpointSeq: number | null = null,
  ): void {
    if (attemptId === null) return;
    const { changes } = this.database.prepare(`
      UPDATE atk_durable_attempts SET status = ?, committed_checkpoint_seq = ?
      WHERE run_id = ? AND attempt_id = ? AND status = 'started'
    `).run(status, checkpointSeq, runId, attemptId);
    if (changes !== 1) throw new Error(`Invalid active attempt ${attemptId}.`);
  }
}
