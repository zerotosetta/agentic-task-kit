import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  SqliteDurableExecutionStore,
  getCheckpoint,
  getDurableAttempts,
  getDurableRun,
  type DurableCheckpoint,
} from "../src/index.js";
import type { FixtureEvent } from "./fixtures/durable-worker.js";

const sourceFixturePath = fileURLToPath(new URL("./fixtures/durable-worker.ts", import.meta.url));
const directories: string[] = [];
const workers: ReturnType<typeof startWorker>[] = [];
let fixtureDirectory: string;
let fixturePath: string;

beforeAll(async () => {
  fixtureDirectory = await mkdtemp(join(tmpdir(), "atk-durable-worker-"));
  fixturePath = join(fixtureDirectory, "worker.mjs");
  await build({
    entryPoints: [sourceFixturePath],
    outfile: fixturePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
  });
}, 30_000);

afterAll(async () => {
  if (fixtureDirectory) await rm(fixtureDirectory, { recursive: true, force: true });
});

function startWorker(databasePath: string, ...args: string[]) {
  const child = fork(fixturePath, [databasePath, ...args], {
    execArgv: [],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  const events: FixtureEvent[] = [];
  let diagnostics = "";
  let finished = false;

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => { diagnostics += chunk; });
  child.on("message", (event: FixtureEvent) => { events.push(event); });
  child.on("error", (error) => { diagnostics += String(error); });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => {
      finished = true;
      resolve({ code, signal });
    });
  });

  return {
    child,
    closed,
    events,
    diagnostics: () => diagnostics,
    kill: () => { if (!finished) child.kill("SIGKILL"); },
    async waitFor<Type extends FixtureEvent["type"]>(type: Type) {
      type Event = Extract<FixtureEvent, { type: Type }>;
      const matches = (event: FixtureEvent): event is Event => event.type === type;
      const earlier = events.find(matches);
      if (earlier) return earlier;
      const details = () => `${args.join(" ")} sent ${events.map(event => event.type).join(", ")}. ${diagnostics}`;
      if (finished) throw new Error(`Worker exited before ${type}. ${details()}`);

      return new Promise<Event>((resolve, reject) => {
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error(`Timed out waiting for ${type}. ${details()}`));
        }, 20_000);
        const onMessage = (event: FixtureEvent) => {
          if (!matches(event)) return;
          cleanup();
          resolve(event);
        };
        const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
          cleanup();
          reject(new Error(`Worker exited with ${code ?? signal} before ${type}. ${details()}`));
        };
        function cleanup() {
          clearTimeout(timeout);
          child.off("message", onMessage);
          child.off("close", onClose);
        }
        child.on("message", onMessage);
        child.once("close", onClose);
      });
    },
  };
}

function launch(databasePath: string, ...args: string[]) {
  const worker = startWorker(databasePath, ...args);
  workers.push(worker);
  return worker;
}

async function createDatabasePath() {
  const directory = await mkdtemp(join(tmpdir(), "atk-durable-process-"));
  directories.push(directory);
  return join(directory, "workflow.sqlite");
}

afterEach(async () => {
  for (const worker of workers) worker.kill();
  await Promise.all(workers.splice(0).map(({ closed }) => closed));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const runId = "fixture-run";

function operations(worker: ReturnType<typeof startWorker>) {
  return worker.events.flatMap((event) => event.type === "work" ? [event.operationKey] : []);
}

function resumeFrom(databasePath: string, checkpoint: DurableCheckpoint, pauseAt = "") {
  return launch(databasePath, "resume", pauseAt, String(checkpoint.checkpointSeq), JSON.stringify(checkpoint.input));
}

describe("durable workflow across Node processes", () => {
  it("resumes the unfinished page after a hard kill between artifact storage and checkpoint publication", async () => {
    const databasePath = await createDatabasePath();
    const worker = launch(databasePath, "start", "collect:page2");
    const staged = await worker.waitFor("paused");

    const store = new SqliteDurableExecutionStore(databasePath);
    try {
      const head = await getCheckpoint(runId, { store });
      expect(head).toMatchObject({
        checkpointSeq: 3,
        committed: {
          operationKey: "collect:page1",
          outcome: {
            code: "page-captured",
            coverage: { requested: 2, observed: 1, complete: false },
            cursor: { token: "fixture-page-2", version: "fixture-snapshot-01" },
          },
        },
        next: {
          operationKey: "collect:page2",
          cursor: { token: "fixture-page-2", version: "fixture-snapshot-01" },
        },
      });
      assert.ok(head?.committed);
      const firstPage = head.committed.artifacts[0];
      const summary = head.committed.artifacts[1];
      assert.ok(firstPage && summary);
      expect(head.committed.outcome).toMatchObject({
        detailsRef: firstPage.id,
        coverageRef: summary.id,
      });
      const stagedBytes = await store.readArtifact(staged.artifact.id);
      assert.ok(stagedBytes);
      expect(Buffer.from(stagedBytes).toString()).toBe('{"temporary":true}');
      expect(JSON.stringify(head)).not.toContain(staged.artifact.id);
      expect(operations(worker)).toEqual(["entry", "discover", "collect:page1", "collect:page2"]);

      worker.kill();
      expect((await worker.closed).code).not.toBe(0);
      await expect.poll(async () => (await getDurableRun(runId, { store }))?.status, {
        timeout: 20_000,
      }).toBe("interrupted");
      expect(await getCheckpoint(runId, { store })).toEqual(head);

      const resumed = resumeFrom(databasePath, head);
      const { result } = await resumed.waitFor("result");
      expect(await resumed.closed, resumed.diagnostics()).toMatchObject({ code: 0 });
      expect(operations(resumed)).toEqual(["collect:page2", "static"]);
      expect(result).toMatchObject({
        status: "completed",
        error: null,
        checkpoint: {
          checkpointSeq: 5,
          committed: { operationKey: "static", outcome: { code: "analysis-complete" } },
          next: null,
        },
      });
      expect(await getCheckpoint(runId, { store, checkpointSeq: 3 })).toEqual(head);

      const secondPageCheckpoint = await getCheckpoint(runId, { store, checkpointSeq: 4 });
      expect(secondPageCheckpoint).toMatchObject({
        committed: {
          operationKey: "collect:page2",
          previousAttemptId: staged.attemptId,
          cursor: { token: "fixture-page-2", version: "fixture-snapshot-01" },
          outcome: {
            code: "collected-partial",
            coverage: { requested: 2, observed: 1, complete: false },
            cursor: null,
            issues: [{ code: "not-captured", key: "fixture.external" }],
          },
        },
      });
      expect(JSON.stringify(await store.listCheckpoints(runId))).not.toContain(staged.artifact.id);
      const pageId = secondPageCheckpoint?.committed?.outcome.detailsRef;
      assert.ok(pageId);
      const secondPageBytes = await store.readArtifact(pageId);
      assert.ok(secondPageBytes);
      expect(JSON.parse(Buffer.from(secondPageBytes).toString("utf8"))).toEqual({
        source: { provider: "test-metadata", version: "fixture-snapshot-01" },
        cells: [{ key: "fixture.external", status: "not-captured" }],
        cursor: null,
      });

      const attempts = await getDurableAttempts(runId, { store });
      expect(attempts?.filter((attempt) => attempt.work.operationKey === "collect:page2")).toEqual([
        expect.objectContaining({
          attemptId: staged.attemptId,
          status: "interrupted",
          committedCheckpointSeq: null,
        }),
        expect.objectContaining({
          attemptId: secondPageCheckpoint?.committed?.attemptId,
          previousAttemptId: staged.attemptId,
          status: "committed",
          committedCheckpointSeq: 4,
        }),
      ]);
    } finally {
      store.close();
    }
  }, 60_000);

  it("lets only one of two resuming processes publish the next checkpoint", async () => {
    const databasePath = await createDatabasePath();
    const initial = launch(databasePath, "prepare");
    const { result } = await initial.waitFor("result");
    expect(await initial.closed, initial.diagnostics()).toMatchObject({ code: 0 });
    expect(result).toMatchObject({
      status: "interrupted",
      checkpoint: { checkpointSeq: 4, next: { operationKey: "static" } },
    });

    const first = resumeFrom(databasePath, result.checkpoint, "static");
    await first.waitFor("paused");
    const second = resumeFrom(databasePath, result.checkpoint);
    expect(await second.waitFor("rejected")).toMatchObject({
      error: { code: "CHECKPOINT_CONFLICT", runId, checkpointSeq: 4 },
    });
    expect(await second.closed, second.diagnostics()).toMatchObject({ code: 0 });
    expect(operations(second)).toEqual([]);

    first.child.send("continue");
    expect(await first.waitFor("result")).toMatchObject({
      result: { status: "completed", checkpoint: { checkpointSeq: 5, previousCheckpointSeq: 4 } },
    });
    expect(await first.closed, first.diagnostics()).toMatchObject({ code: 0 });
    expect(operations(first)).toEqual(["static"]);

    const store = new SqliteDurableExecutionStore(databasePath);
    try {
      expect(await getCheckpoint(runId, { store })).toMatchObject({ checkpointSeq: 5 });
      const attempts = await getDurableAttempts(runId, { store });
      expect(attempts?.filter((attempt) => attempt.work.operationKey === "static")).toEqual([
        expect.objectContaining({ status: "committed", committedCheckpointSeq: 5 }),
      ]);
    } finally {
      store.close();
    }
  }, 60_000);
});
