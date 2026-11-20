import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

  it("pins published bytes, scopes replay keys and pages history across concurrent appends and restarts", () => {
    const first = open();
    const {sessionId} = first.create(request);
    const other = first.create({...request, idempotencyKey: "two"}).sessionId;
    const edit = {sessionId, path: "result.txt", content: "original", expectedVersion: 0, actor: "writer"};
    const original = first.writeFile(edit);
    const publication = {sessionId, path: edit.path, version: 1, role: "final" as const,
      actor: "editor", stage: "review", reason: "accepted", idempotencyKey: "result"};
    const result = first.publish(publication);
    expect(result).toMatchObject({sha256: original.sha256, size: original.size});
    first.writeFile({...edit, expectedVersion: 1, content: "rewritten"});
    first.writeFile({...edit, sessionId: other, content: "separate"});
    expect(first.publish({...publication, sessionId: other}).sha256).not.toBe(result.sha256);
    for (const store of stores.splice(0)) store.close();
    const reopened = open();
    expect(reopened.publish(publication)).toEqual(result);
    expect(reopened.writeFile(edit)).toEqual(original);
    expect(() => reopened.writeFile({...edit, actor: "another writer"})).toThrowError(expect.objectContaining({code: "VERSION_CONFLICT"}));
    expect(reopened.listPublications(sessionId)).toEqual([result]);
    expect(reopened.readPublication(result)).toEqual({...result, content: "original"});
    expect(() => reopened.readPublication({...result, sessionId: other})).toThrowError(expect.objectContaining({code: "ARTIFACT_NOT_FOUND"}));
    expect(() => reopened.publish({...publication, reason: "new rationale"})).toThrowError(expect.objectContaining({code: "IDEMPOTENCY_CONFLICT"}));
    expect(() => reopened.publish({...publication, version: 3, idempotencyKey: "missing"})).toThrowError(expect.objectContaining({code: "FILE_NOT_FOUND"}));
    const page = reopened.history({sessionId, limit: 2});
    expect(page.events.map(e => e.type)).toEqual(["workspace_write", "artifact_publish"]);
    expect(page.events[1]).toMatchObject({role: "final", reason: "accepted", publicationId: result.publicationId, sha256: original.sha256});
    const note = {sessionId, expectedVersion: 1, summary: "ready", nextAction: "", stage: "handoff"};
    reopened.note(note);
    reopened.note(note);
    expect(() => reopened.note({...note, reason: "other change"})).toThrowError(expect.objectContaining({code: "VERSION_CONFLICT"}));
    const older = reopened.history({sessionId, beforeSeq: page.nextBeforeSeq!});
    expect(older.nextBeforeSeq).toBeNull();
    expect(older.events).toHaveLength(1);
    expect(older.events[0]).toMatchObject({type: "workspace_write", version: 1, actor: "writer", stage: null});
    const history = reopened.history({sessionId}).events;
    expect(history).toHaveLength(4);
    expect(history[0]).toMatchObject({type: "note_edit", version: 2, stage: "handoff", actor: null});
  });

  it("backfills existing file revisions and edited notes exactly once with unknown attribution", () => {
    const initial = open();
    const {sessionId} = initial.create(request);
    const file = initial.writeFile({sessionId, path: "a", content: "b", expectedVersion: 0});
    const note = initial.note({sessionId, expectedVersion: 1, summary: "", nextAction: "finish"});
    for (const store of stores.splice(0)) store.close();
    const db = new DatabaseSync(join(dir, "sessions.sqlite"));
    try { db.exec("DROP TABLE session_history; DROP TABLE publications"); }
    finally { db.close(); }
    const events = open().history({sessionId}).events;
    expect(events).toHaveLength(2);
    expect(events).toContainEqual(expect.objectContaining({type: "workspace_write", version: 1, path: "a",
      createdAt: file.updatedAt, sha256: file.sha256, actor: null, stage: null, reason: null}));
    expect(events).toContainEqual(expect.objectContaining({type: "note_edit", version: 2,
      createdAt: note.updatedAt, actor: null, stage: null, reason: null}));
    expect(open().history({sessionId}).events).toEqual(events);
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
