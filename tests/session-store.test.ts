import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionStore } from "../src/sessions/store.js";

describe("SessionStore", () => {
  let dir: string;
  let stores: SessionStore[];
  const open = () => {
    const store = new SessionStore(dir);
    stores.push(store);
    return store;
  };
  const request = {title: "같은 이름", goal: "audit pending work", idempotencyKey: "one"};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "atk-session-"));
    stores = [];
  });
  afterEach(() => {
    for (const store of stores) store.close();
    rmSync(dir, {recursive: true, force: true});
  });

  it("reopens notes and replays committed replies across connections and later revisions", () => {
    const first = open();
    const second = open();
    const session = first.create(request);
    const input = {sessionId: session.sessionId, expectedVersion: 1, summary: "reviewed", nextAction: "ship"};
    const note = first.note(input);
    expect(() => second.note({...input, summary: "stale"})).toThrowError(expect.objectContaining({code: "VERSION_CONFLICT"}));
    const latest = second.note({...input, expectedVersion: 2, nextAction: "done"});
    for (const store of stores.splice(0)) store.close();
    const reopened = open();
    expect(reopened.get(session.sessionId)).toEqual(latest);
    expect(reopened.note(input)).toEqual(note);
    expect(reopened.create(request)).toEqual(session);
    expect(() => reopened.create({...request, goal: "other"})).toThrowError(expect.objectContaining({code: "IDEMPOTENCY_CONFLICT"}));
  });

  it("discovers duplicate titles by title or goal with stable pagination", () => {
    const store = open();
    const ids = [store.create(request), store.create({...request, idempotencyKey: "two"})].map(s => s.sessionId);
    const all = store.list({query: "같은"});
    expect(all.map(s => s.sessionId).sort()).toEqual(ids.sort());
    expect(store.list({query: "PENDING", offset: 1, limit: 1})).toEqual(all.slice(1));
    expect(store.list({query: "%"})).toEqual([]);
  });

  it("isolates immutable file versions and resolves competing edits with CAS", () => {
    const a = open();
    const b = open();
    const {sessionId} = a.create(request);
    const other = b.create({...request, idempotencyKey: "two"});
    const input = {sessionId, path: "work/한글.txt", expectedVersion: 0, content: "한😀"};
    const original = a.writeFile(input);
    expect(original.size).toBe(7);
    expect(original.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => b.writeFile({...input, content: "competing"})).toThrowError(expect.objectContaining({code: "VERSION_CONFLICT"}));
    const latest = b.writeFile({...input, expectedVersion: 1, content: ""});
    for (const store of stores.splice(0)) store.close();
    const c = open();
    expect(c.writeFile(input)).toEqual(original);
    expect(c.readFile({...input, version: 1})).toEqual({...original, content: input.content});
    expect(c.readFile(input)).toEqual({...latest, content: ""});
    expect(c.listFiles(sessionId)).toEqual([latest]);
    expect(c.listFiles(other.sessionId)).toEqual([]);
    expect(() => c.readFile({...input, sessionId: other.sessionId})).toThrowError(expect.objectContaining({code: "FILE_NOT_FOUND"}));
  });

  it("rejects traversal, malformed text, oversized files and invalid versions", () => {
    const store = open();
    const {sessionId} = store.create(request);
    const input = {sessionId, path: "a", content: "", expectedVersion: 0};
    for (const path of ["../outside", "/outside", "a//b", "a/./b", "C:/x", "a\\b"]) {
      expect(() => store.writeFile({...input, path})).toThrowError(expect.objectContaining({code: "INVALID_ARGUMENT"}));
    }
    for (const content of ["한".repeat(350000), "\uD800"]) {
      expect(() => store.writeFile({...input, content})).toThrowError(expect.objectContaining({code: "INVALID_ARGUMENT"}));
    }
    expect(() => store.writeFile({...input, expectedVersion: -1})).toThrowError(expect.objectContaining({code: "INVALID_ARGUMENT"}));
    expect(() => store.listFiles("missing")).toThrowError(expect.objectContaining({code: "SESSION_NOT_FOUND"}));
  });
});
