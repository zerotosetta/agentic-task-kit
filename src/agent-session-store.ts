import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentSessionState, AgentSessionStore } from "./types/agent.js";

function identifier(value: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/u.test(value)) throw new Error("Invalid agent session ID.");
  return value;
}
const copy = <T>(value: T): T => structuredClone(value);

export class InMemoryAgentSessionStore implements AgentSessionStore {
  private readonly states = new Map<string, AgentSessionState>();
  private readonly locks = new Set<string>();
  async load(sessionId: string): Promise<AgentSessionState | null> {
    const state = this.states.get(sessionId);
    return state ? copy(state) : null;
  }
  async save(state: AgentSessionState): Promise<void> { this.states.set(state.sessionId, copy(state)); }
  async withLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    identifier(sessionId);
    if (this.locks.has(sessionId)) throw new Error("Agent session is already running.");
    this.locks.add(sessionId);
    try { return await operation(); } finally { this.locks.delete(sessionId); }
  }
}

/** Atomic checkpoint replacement and exclusive session ownership across processes. */
export class FileAgentSessionStore implements AgentSessionStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  async load(sessionId: string): Promise<AgentSessionState | null> {
    let content: string;
    try { content = await readFile(join(this.directory, `${identifier(sessionId)}.json`), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    const envelope = JSON.parse(content) as { version: string; sha256: string; state: AgentSessionState };
    const digest = createHash("sha256").update(JSON.stringify(envelope.state)).digest("hex");
    if (envelope.version !== "atk-agent-checkpoint.v1" || envelope.sha256 !== digest || envelope.state.sessionId !== sessionId)
      throw new Error("Invalid agent checkpoint or checksum.");
    return envelope.state;
  }
  async save(state: AgentSessionState): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const destination = join(this.directory, `${identifier(state.sessionId)}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    const content = JSON.stringify({ version: "atk-agent-checkpoint.v1", sha256: createHash("sha256").update(JSON.stringify(state)).digest("hex"), state });
    const file = await open(temporary, "wx");
    try { await file.writeFile(content, "utf8"); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, destination); }
    finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
  }
  async withLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true });
    const path = join(this.directory, `${identifier(sessionId)}.lock`);
    const lock = await open(path, "wx");
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return await operation();
    } finally { await lock.close(); await unlink(path); }
  }
}
