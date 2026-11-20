import { createHash, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { McpWorkflowError } from "../mcp/config.js";

export interface SessionRecord {
  sessionId: string;
  title: string;
  goal: string;
  version: number;
  summary: string;
  nextAction: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionFileMetadata {
  path: string;
  version: number;
  sha256: string;
  size: number;
  updatedAt: string;
}

export interface SessionFile extends SessionFileMetadata {
  content: string;
}

function invalid(message: string): never {
  throw new McpWorkflowError("INVALID_ARGUMENT", message);
}

function object(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("Expected an input object.");
}

function string(value: unknown, name: string, max: number, allowBlank = false): asserts value is string {
  if (typeof value !== "string" || (!allowBlank && !value.trim()) ||
      value.includes("\0") || /[\uD800-\uDFFF]/u.test(value) || Buffer.byteLength(value) > max) {
    invalid(name + " must be valid UTF-8 text within " + max + " bytes.");
  }
}

function integer(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    invalid(name + " must be a whole number from " + min + " to " + max + ".");
  }
}

function filePath(path: string): void {
  string(path, "path", 1024);
  if (/[\\:\x00-\x1f\x7f]/u.test(path) || path.split("/").some(p => !p || p === "." || p === "..")) {
    invalid("path must be a relative virtual file path.");
  }
}

function conflict(current: number): never {
  throw new McpWorkflowError("VERSION_CONFLICT", "Current version is " + current + ".");
}

const columns = "s.sessionId, s.title, s.goal, n.version, n.summary, n.nextAction, s.createdAt, n.updatedAt";
const sessions = " FROM sessions s JOIN notes n ON s.sessionId = n.sessionId ";
const latest = "n.version = (SELECT MAX(version) FROM notes WHERE sessionId = s.sessionId)";
const metadata = "path, version, sha256, size, updatedAt";

export class SessionStore {
  private readonly db: DatabaseSync;

  constructor(stateDirectory: string) {
    string(stateDirectory, "stateDirectory", 32768);
    mkdirSync(stateDirectory, { recursive: true });
    const sqlite = createRequire(import.meta.url)("node:sqlite") as typeof import("node:sqlite");
    this.db = new sqlite.DatabaseSync(join(stateDirectory, "sessions.sqlite"));
    try {
      this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
      this.transaction(() => this.db.exec(`
        CREATE TABLE IF NOT EXISTS sessions (
          sessionId TEXT PRIMARY KEY, title TEXT NOT NULL, goal TEXT NOT NULL,
          idempotencyKey TEXT UNIQUE NOT NULL, createdAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notes (
          sessionId TEXT NOT NULL REFERENCES sessions, version INTEGER NOT NULL, summary TEXT NOT NULL,
          nextAction TEXT NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY(sessionId, version)
        );
        CREATE TABLE IF NOT EXISTS files (
          sessionId TEXT NOT NULL REFERENCES sessions, path TEXT NOT NULL, version INTEGER NOT NULL,
          sha256 TEXT NOT NULL, size INTEGER NOT NULL, updatedAt TEXT NOT NULL, content TEXT NOT NULL,
          PRIMARY KEY(sessionId, path, version)
        );
      `));
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  private transaction<T>(action: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = action();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  create(input: {title: string; goal: string; idempotencyKey: string}): SessionRecord {
    object(input);
    const {title, goal, idempotencyKey} = input;
    string(title, "title", 1024);
    string(goal, "goal", 65536);
    string(idempotencyKey, "idempotencyKey", 512);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT " + columns + sessions + "WHERE idempotencyKey = ? AND n.version = 1")
        .get(idempotencyKey) as unknown as SessionRecord | undefined;
      if (existing) {
        if (existing.title === title && existing.goal === goal) return existing;
        throw new McpWorkflowError("IDEMPOTENCY_CONFLICT", "The creation key already identifies a different request.");
      }
      const sessionId = randomUUID();
      const time = new Date().toISOString();
      this.db.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?)").run(sessionId, title, goal, idempotencyKey, time);
      this.db.prepare("INSERT INTO notes VALUES (?, 1, '', '', ?)").run(sessionId, time);
      return this.get(sessionId);
    });
  }

  list(input: {query?: string; limit?: number; offset?: number} = {}): SessionRecord[] {
    object(input);
    const {query = "", limit = 25, offset = 0} = input;
    string(query, "query", 1024, true);
    integer(limit, "limit", 1, 101);
    integer(offset, "offset", 0);
    return this.db.prepare("SELECT " + columns + sessions + "WHERE " + latest +
      " AND (instr(lower(s.title), lower(?)) OR instr(lower(s.goal), lower(?)) OR s.sessionId = ?)" +
      " ORDER BY n.updatedAt DESC, s.sessionId LIMIT ? OFFSET ?").all(query, query, query, limit, offset) as unknown as SessionRecord[];
  }

  get(sessionId: string): SessionRecord {
    string(sessionId, "sessionId", 256);
    const row = this.db.prepare("SELECT " + columns + sessions + "WHERE s.sessionId = ? ORDER BY n.version DESC LIMIT 1")
      .get(sessionId) as unknown as SessionRecord | undefined;
    if (!row) throw new McpWorkflowError("SESSION_NOT_FOUND", "Session does not exist.");
    return row;
  }

  note(input: {sessionId: string; expectedVersion: number; summary: string; nextAction: string}): SessionRecord {
    object(input);
    const {sessionId, expectedVersion, summary, nextAction} = input;
    integer(expectedVersion, "expectedVersion", 1);
    string(summary, "summary", 65536, true);
    string(nextAction, "nextAction", 65536, true);
    return this.transaction(() => {
      const current = this.get(sessionId);
      if (current.version !== expectedVersion) {
        const previous = this.db.prepare("SELECT " + columns + sessions + "WHERE s.sessionId = ? AND n.version = ?")
          .get(sessionId, expectedVersion + 1) as unknown as SessionRecord | undefined;
        if (previous?.summary === summary && previous.nextAction === nextAction) return previous;
        conflict(current.version);
      }
      this.db.prepare("INSERT INTO notes VALUES (?, ?, ?, ?, ?)").run(sessionId, expectedVersion + 1, summary, nextAction, new Date().toISOString());
      return this.get(sessionId);
    });
  }

  listFiles(sessionId: string): SessionFileMetadata[] {
    this.get(sessionId);
    return this.db.prepare("SELECT " + metadata + " FROM files f WHERE sessionId = ? AND version = " +
      "(SELECT MAX(version) FROM files WHERE sessionId = f.sessionId AND path = f.path) ORDER BY path")
      .all(sessionId) as unknown as SessionFileMetadata[];
  }

  writeFile(input: {sessionId: string; path: string; expectedVersion: number; content: string}): SessionFileMetadata {
    object(input);
    const {sessionId, path, expectedVersion, content} = input;
    filePath(path);
    integer(expectedVersion, "expectedVersion", 0);
    string(content, "content", 1048576, true);
    return this.transaction(() => {
      this.get(sessionId);
      const row = this.db.prepare("SELECT MAX(version) AS version FROM files WHERE sessionId = ? AND path = ?").get(sessionId, path);
      const current = Number(row?.version ?? 0);
      if (current !== expectedVersion) {
        const existing = this.db.prepare("SELECT " + metadata + " FROM files WHERE sessionId = ? AND path = ? AND version = ? AND content = ?")
          .get(sessionId, path, expectedVersion + 1, content) as unknown as SessionFileMetadata | undefined;
        if (existing) return existing;
        conflict(current);
      }
      const version = expectedVersion + 1;
      const sha256 = createHash("sha256").update(content).digest("hex");
      const size = Buffer.byteLength(content);
      const updatedAt = new Date().toISOString();
      this.db.prepare("INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?)").run(sessionId, path, version, sha256, size, updatedAt, content);
      return {path, version, sha256, size, updatedAt};
    });
  }

  readFile(input: {sessionId: string; path: string; version?: number}): SessionFile {
    object(input);
    const {sessionId, path, version} = input;
    filePath(path);
    this.get(sessionId);
    if (version !== undefined) integer(version, "version", 1);
    const row = this.db.prepare("SELECT " + metadata + ", content FROM files WHERE sessionId = ? AND path = ?" +
      (version === undefined ? " ORDER BY version DESC LIMIT 1" : " AND version = ?"))
      .get(sessionId, path, ...(version === undefined ? [] : [version])) as unknown as SessionFile | undefined;
    if (!row) throw new McpWorkflowError("FILE_NOT_FOUND", "File or requested version does not exist.");
    return row;
  }
}
