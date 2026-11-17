import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  advanceInput,
  getCheckpoint,
  getDurableAttempts,
  getDurableRun,
  resumeDurable,
  runDurable,
  SqliteDurableExecutionStore,
  type DurableArtifactRef,
  type DurableExecutionStore,
  type DurableJSON,
  type DurableStepContext,
  type DurableWork,
  type DurableWorkflow,
  type SnapshotInput,
} from "../src/index.js";

const revision = "fixture-static-v2";
const affectedPath = "/fixture/affected.jsp";
const unchangedPath = "/fixture/unchanged.jsp";
const temporaryRoot = resolve(tmpdir());
const directories: string[] = [];
const openStores: SqliteDurableExecutionStore[] = [];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function openStore(): SqliteDurableExecutionStore {
  const directory = mkdtempSync(join(temporaryRoot, "atk-durable-contract-"));
  directories.push(directory);
  const store = new SqliteDurableExecutionStore(join(directory, "execution.sqlite"));
  openStores.push(store);
  return store;
}

afterEach(() => {
  for (const store of openStores.splice(0)) store.close();
  for (const directory of directories.splice(0)) {
    if (dirname(resolve(directory)) !== temporaryRoot) throw new Error("Unexpected test cleanup path.");
    rmSync(directory, { recursive: true, force: true });
  }
});

function work(stepKey: string, operationKey: string, scope: DurableJSON, inputHashes: readonly string[] = []): DurableWork {
  return {
    stepKey,
    operationKey,
    scope,
    cacheFingerprint: digest(JSON.stringify([revision, stepKey, scope, inputHashes])),
  };
}

async function put(store: Pick<DurableExecutionStore, "putArtifact">, kind: string, value: string): Promise<DurableArtifactRef> {
  return store.putArtifact(kind, Buffer.from(value));
}

async function snapshot(
  store: DurableExecutionStore,
  snapshotId: string,
  artifacts: readonly DurableArtifactRef[],
): Promise<SnapshotInput> {
  const manifest = await put(store, "manifest", JSON.stringify({ snapshotId, artifacts }));
  return { snapshotId, manifestId: manifest.id, sha256: manifest.sha256, artifacts };
}

describe("durable execution contract", () => {
  it.each([true, false])("persists the scoped 6→4→6 repair and honors caller progress policy (repaired=%s)", async (repaired) => {
    const store = openStore();
    const sourceA = await put(store, "source", "fixture source A");
    const sourceB = await put(store, "source", "fixture source B");
    const input = await snapshot(store, "initial", [sourceA, sourceB]);
    const scope = { sourcePaths: [affectedPath, unchangedPath] };
    const repairScope = { sourcePaths: [affectedPath] };
    const first = work("static", "static:initial", scope, [sourceA.sha256, sourceB.sha256]);
    const calls: string[] = [];
    const missing = { code: "not-captured", key: "QUERY_UNKNOWN", request: "Provide the query definition." };
    const scheduleWithEvidence = (next: DurableWork, affected: DurableArtifactRef, unchanged: DurableArtifactRef): DurableWork => ({
      ...next,
      cursor: { affectedId: affected.id, unchangedId: unchanged.id },
    });
    function evidenceFor(ctx: DurableStepContext) {
      const cursor = ctx.work.cursor as { affectedId: string; unchangedId: string };
      const affected = ctx.getArtifactRef(cursor.affectedId);
      const unchanged = ctx.getArtifactRef(cursor.unchangedId);
      if (!affected || !unchanged) throw new Error("Missing checkpoint evidence.");
      return { affected, unchanged };
    }
    const workflow: DurableWorkflow = {
      workflowKey: "scoped-repair-fixture",
      revision,
      steps: {
        async static(ctx) {
          calls.push(ctx.work.operationKey);
          if (ctx.work.operationKey === first.operationKey) {
            expect(ctx.work.scope).toEqual(scope);
            expect(Buffer.from(await ctx.readArtifact(sourceB)).toString()).toBe("fixture source B");
            const unchanged = await put(ctx, "evidence", "B:verified");
            const affected = await put(ctx, "evidence", "A:unverified");
            return {
              outcome: { code: "draft", issues: [missing] },
              artifacts: [affected, unchanged],
              next: scheduleWithEvidence(work("llm", "llm:skip", scope), affected, unchanged),
            };
          }
          expect(ctx.work.scope).toEqual({ ...repairScope, reasonRef: ctx.checkpoint.committed?.outcome.detailsRef });
          expect(Buffer.from(await ctx.readArtifact(sourceA)).toString()).toBe("fixture source A");
          const { unchanged } = evidenceFor(ctx);
          const affected = await put(ctx, "evidence", repaired ? "A:verified" : "A:unverified");
          return {
            outcome: { code: "reanalysis-finished", issues: [missing] },
            artifacts: [affected],
            next: scheduleWithEvidence(work("verify", "verify:repair", scope, [affected.sha256, unchanged.sha256]), affected, unchanged),
          };
        },
        llm(ctx) {
          calls.push(ctx.work.operationKey);
          const { affected, unchanged } = evidenceFor(ctx);
          return {
            outcome: { code: "skipped" },
            next: scheduleWithEvidence(work("verify", "verify:initial", scope, [affected.sha256]), affected, unchanged),
          };
        },
        async verify(ctx) {
          calls.push(ctx.work.operationKey);
          const { affected, unchanged } = evidenceFor(ctx);
          const evidence = Buffer.from(await ctx.readArtifact(affected)).toString();
          if (evidence === "A:verified") {
            return {
              outcome: { code: "verified", issues: [missing] },
              next: scheduleWithEvidence(work("publish", "publish:spec", scope, [affected.sha256, unchanged.sha256]), affected, unchanged),
            };
          }
          const issue = { code: "evidence-mismatch", ...repairScope };
          const verification = await put(ctx, "verification", JSON.stringify(issue));
          const stalled = ctx.work.operationKey === "verify:repair";
          return {
            outcome: { code: stalled ? "repair-stalled" : "repair-needed", issues: [issue, missing], detailsRef: verification.id },
            artifacts: [verification],
            next: stalled
              ? null
              : scheduleWithEvidence(
                work("static", "static:repair", { ...repairScope, reasonRef: verification.id }, [sourceA.sha256]),
                affected,
                unchanged,
              ),
          };
        },
        async publish(ctx) {
          calls.push(ctx.work.operationKey);
          const { affected, unchanged } = evidenceFor(ctx);
          expect(Buffer.from(await ctx.readArtifact(unchanged)).toString()).toBe("B:verified");
          const spec = await put(ctx, "spec", JSON.stringify({ evidenceIds: [affected.id, unchanged.id], issues: [missing] }));
          return {
            outcome: { code: "published-with-gaps", detailsRef: spec.id, issues: [missing] },
            artifacts: [spec],
            next: null,
          };
        },
      },
    };

    const paused = await runDurable(workflow, { input, first, store, maxSteps: 3 });
    expect(paused.checkpoint.committed?.outcome.code).toBe("repair-needed");
    expect(paused.checkpoint.next).toMatchObject({ operationKey: "static:repair", scope: repairScope });
    const initial = await getCheckpoint(paused.runId, { store, checkpointSeq: 1 });
    expect(paused.checkpoint.next?.cursor).toEqual({
      affectedId: initial?.committed?.artifacts[0]?.id,
      unchangedId: initial?.committed?.artifacts[1]?.id,
    });

    const final = await resumeDurable(paused.runId, {
      workflow,
      expectedInput: input,
      expectedCheckpointSeq: paused.checkpoint.checkpointSeq,
      store,
    });
    const expectedCalls = ["static:initial", "llm:skip", "verify:initial", "static:repair", "verify:repair"];
    expect(final.status).toBe("completed");
    if (repaired) {
      expect(calls).toEqual([...expectedCalls, "publish:spec"]);
      expect(final.checkpoint.committed?.outcome).toMatchObject({ code: "published-with-gaps", issues: [missing] });
      const reanalysis = await getCheckpoint(final.runId, { store, checkpointSeq: 4 });
      const spec = await store.readArtifact(final.checkpoint.committed!.outcome.detailsRef!);
      expect(JSON.parse(Buffer.from(spec!).toString())).toEqual({
        evidenceIds: [reanalysis!.committed!.artifacts[0]!.id, initial!.committed!.artifacts[1]!.id],
        issues: [missing],
      });
    } else {
      expect(calls).toEqual(expectedCalls);
      expect(final.checkpoint.committed?.outcome).toMatchObject({
        code: "repair-stalled",
        issues: [{ code: "evidence-mismatch", ...repairScope }, missing],
      });
    }
    expect(final.checkpoint.next).toBeNull();
    expect((await getCheckpoint(paused.runId, { store, checkpointSeq: 2 }))?.committed?.outcome.code).toBe("skipped");
  });

  it("opens an explicit input generation and retains selected committed evidence", async () => {
    const store = openStore();
    const originalSource = await put(store, "source", "original fixture source");
    const dependency = await put(store, "source", "newly collected dependency");
    const input = await snapshot(store, "without-dependency", [originalSource]);
    const nextInput = await snapshot(store, "with-dependency", [originalSource, dependency]);
    const scope = { sourcePaths: [affectedPath], dependencyKeys: ["TASK_DEPENDENCY"] };
    const cursor = { page: 2, selector: "TASK_DEPENDENCY", sourceVersion: "fixture-v1" };
    const coverage = { requested: ["TASK_DEPENDENCY"], seen: ["TASK_DEPENDENCY"], complete: false };
    let retained: DurableArtifactRef;
    let superseded: DurableArtifactRef;
    const unattached = await put(store, "evidence", "never committed");
    const first = work("static", "static:initial", { sourcePaths: [affectedPath, unchangedPath] }, [originalSource.sha256]);
    const collect = work("collect", "collect:dependency", scope, [dependency.sha256]);
    const workflow: DurableWorkflow = {
      workflowKey: "changed-input-fixture",
      revision,
      steps: {
        async static(ctx) {
          if (ctx.work.operationKey === first.operationKey) {
            retained = await put(ctx, "evidence", "unchanged evidence");
            superseded = await put(ctx, "evidence", "previous affected evidence");
            return { outcome: { code: "dependency-discovered" }, artifacts: [retained, superseded], next: collect };
          }
          expect(ctx.work.scope).toEqual(scope);
          expect(ctx.work.cursor).toEqual(cursor);
          expect(ctx.checkpoint.committed?.outcome).toMatchObject({ coverage, cursor });
          return { outcome: { code: "new-input-statically-verified", detailsRef: retained.id }, next: null };
        },
        async collect(ctx) {
          expect(Buffer.from(await ctx.readArtifact(dependency)).toString()).toBe("newly collected dependency");
          expect(Buffer.from(await ctx.readArtifact(retained)).toString()).toBe("unchanged evidence");
          expect(ctx.getArtifactRef(retained.id)).toEqual(retained);
          expect(ctx.getArtifactRef(superseded.id)).toBeNull();
          await expect(ctx.readArtifact(superseded)).rejects.toMatchObject({ code: "INVALID_WORK", artifactId: superseded.id });
          const evidence = await put(ctx, "coverage", JSON.stringify(coverage));
          return {
            outcome: { code: "partial", coverage, coverageRef: evidence.id, cursor },
            artifacts: [evidence],
            next: { ...work("static", "static:new-input", scope, [dependency.sha256]), cursor },
          };
        },
      },
    };
    const paused = await runDurable(workflow, { input, first, store, maxSteps: 1 });
    expect(paused.checkpoint.committed?.outcome.code).toBe("dependency-discovered");
    const change = {
      workflow,
      expectedCheckpointSeq: paused.checkpoint.checkpointSeq,
      input: nextInput,
      affectedScope: scope,
      next: collect,
      store,
    };
    await expect(resumeDurable(paused.runId, { workflow, expectedInput: nextInput, store }))
      .rejects.toMatchObject({ code: "INPUT_SNAPSHOT_MISMATCH", checkpointSeq: paused.checkpoint.checkpointSeq });
    await expect(advanceInput(paused.runId, { ...change, reuseArtifactIds: [unattached.id] })).rejects.toMatchObject({
      artifactId: unattached.id,
    });
    expect(await getCheckpoint(paused.runId, { store })).toEqual(paused.checkpoint);

    const changed = await advanceInput(paused.runId, { ...change, reuseArtifactIds: [retained!.id] });
    expect(changed).toMatchObject({
      checkpointSeq: paused.checkpoint.checkpointSeq + 1,
      previousCheckpointSeq: paused.checkpoint.checkpointSeq,
      generation: paused.checkpoint.generation + 1,
      input: nextInput,
      inputChange: { affectedScope: scope, reuseArtifactIds: [retained!.id], retainedArtifacts: [retained!] },
      next: collect,
    });
    const final = await resumeDurable(paused.runId, { workflow, expectedInput: nextInput, store });
    expect(final).toMatchObject({
      status: "completed",
      checkpoint: { generation: changed.generation, committed: { outcome: { code: "new-input-statically-verified" } } },
    });
  });


  it("rejects wrong revisions, sequences, and snapshot or artifact hashes before advancing the head", async () => {
    const store = openStore();
    const source = await put(store, "source", "original source");
    const input = await snapshot(store, "pinned", [source]);
    const first = work("capture", "capture", { key: "TASK_A" }, [source.sha256]);
    const next = work("finish", "finish", null);
    const finish = vi.fn(() => ({ outcome: { code: "finished" }, next: null }));
    let captured: DurableArtifactRef;
    const workflow: DurableWorkflow = {
      workflowKey: "integrity-fixture",
      revision,
      steps: {
        async capture(ctx) {
          captured = await put(ctx, "lookup", "captured value");
          return { outcome: { code: "captured", detailsRef: captured.id }, artifacts: [captured], next };
        },
        finish,
      },
    };
    await expect(runDurable(workflow, { input: { ...input, sha256: digest("false manifest") }, first, store }))
      .rejects.toMatchObject({ code: "ARTIFACT_MISMATCH", runId: null, checkpointSeq: null, artifactId: input.manifestId });
    const paused = await runDurable(workflow, { input, first, store, maxSteps: 1 });
    const checkpointSeq = paused.checkpoint.checkpointSeq;
    const resume = { workflow, expectedInput: input, expectedCheckpointSeq: checkpointSeq, store };
    await expect(resumeDurable(paused.runId, { ...resume, workflow: { ...workflow, revision: "changed" } }))
      .rejects.toMatchObject({ code: "WORKFLOW_REVISION_MISMATCH", checkpointSeq });
    await expect(resumeDurable(paused.runId, { ...resume, expectedCheckpointSeq: checkpointSeq - 1 }))
      .rejects.toMatchObject({ code: "CHECKPOINT_CONFLICT", checkpointSeq });
    await expect(resumeDurable(paused.runId, { ...resume, expectedInput: { ...input, sha256: digest("different") } }))
      .rejects.toMatchObject({ code: "INPUT_SNAPSHOT_MISMATCH", checkpointSeq });

    const realRead = store.readArtifact.bind(store);
    for (const id of [source.id, captured!.id]) {
      const corruptedRead = vi.spyOn(store, "readArtifact").mockImplementation(async (candidate) =>
        candidate === id ? Buffer.from("tampered bytes") : realRead(candidate));
      await expect(resumeDurable(paused.runId, resume))
        .rejects.toMatchObject({ code: "ARTIFACT_MISMATCH", artifactId: id, checkpointSeq });
      expect(await getCheckpoint(paused.runId, { store })).toEqual(paused.checkpoint);
      expect(finish).not.toHaveBeenCalled();
      corruptedRead.mockRestore();
    }

    expect((await resumeDurable(paused.runId, resume)).status).toBe("completed");
    expect(finish).toHaveBeenCalledTimes(1);
  });

  it("preserves the cursor and links a cancelled attempt to its same-operation retry", async () => {
    const store = openStore();
    const input = await snapshot(store, "paged", []);
    const controller = new AbortController();
    const cursor = { token: "fixture-page-2", sourceVersion: "v1" };
    const first = work("lookup", "lookup:page-1", { selector: "TASK_A" });
    const second = { ...work("lookup", "lookup:page-2", first.scope), cursor };
    const calls: string[] = [];
    let abandoned: DurableArtifactRef;
    const workflow: DurableWorkflow = {
      workflowKey: "cancel-fixture",
      revision,
      steps: {
        async lookup(ctx) {
          calls.push(ctx.work.operationKey);
          if (ctx.work.operationKey === first.operationKey) {
            return { outcome: { code: "partial", cursor }, next: second };
          }
          expect(ctx.work.cursor).toEqual(cursor);
          if (!ctx.previousAttemptId) {
            abandoned = await put(ctx, "lookup-page", "uncommitted page");
            controller.abort(new Error("cancel after staging"));
            return { outcome: { code: "found" }, artifacts: [abandoned], next: null };
          }
          const committed = await put(ctx, "lookup-page", "retried page");
          return { outcome: { code: "found", detailsRef: committed.id }, artifacts: [committed], next: null };
        },
      },
    };
    const cancelled = await runDurable(workflow, { input, first, store, signal: controller.signal });
    expect(cancelled).toMatchObject({
      status: "cancelled",
      error: { code: "CANCELLED" },
      checkpoint: { committed: { operationKey: first.operationKey, outcome: { cursor } }, next: second },
    });
    expect(await getCheckpoint(cancelled.runId, { store })).toEqual(cancelled.checkpoint);

    const finished = await resumeDurable(cancelled.runId, { workflow, expectedInput: input, store });
    const attempts = await getDurableAttempts(cancelled.runId, { store });
    expect(finished.status).toBe("completed");
    expect(calls).toEqual([first.operationKey, second.operationKey, second.operationKey]);
    expect(attempts.map((attempt) => [attempt.work.operationKey, attempt.status])).toEqual([
      [first.operationKey, "committed"],
      [second.operationKey, "cancelled"],
      [second.operationKey, "committed"],
    ]);
    expect(finished.checkpoint.committed).toMatchObject({
      operationKey: second.operationKey,
      previousAttemptId: attempts[1]!.attemptId,
      attemptId: attempts[2]!.attemptId,
    });
    expect(finished.checkpoint.committed?.artifacts.map(({ id }) => id)).not.toContain(abandoned!.id);
  });

  it("reuses an exactly matching committed result with a new continuation and records its lineage", async () => {
    const store = openStore();
    const input = await snapshot(store, "cache", []);
    const first = work("scan", "scan:evidence", { sourcePaths: [affectedPath] });
    const alternateScope = { ...first, scope: { sourcePaths: [unchangedPath] } };
    const route = work("route", "route:verification", null);
    const realScan = vi.fn();
    const outcome = { code: "found", coverage: { complete: true }, cursor: { page: 3 } };
    const workflow: DurableWorkflow = {
      workflowKey: "reuse-fixture",
      revision,
      steps: {
        async scan(ctx) {
          const cached = ctx.findReusableWork();
          if (cached) return { reuseFrom: cached.checkpointSeq, next: alternateScope };
          await realScan(ctx.work.scope);
          const artifact = await put(ctx, "evidence", JSON.stringify(ctx.work.scope));
          const next = ctx.checkpoint.committed ? null : route;
          return { outcome, artifacts: [artifact], next };
        },
        route() {
          return { outcome: { code: "run-verification-again" }, next: first };
        },
      },
    };
    const final = await runDurable(workflow, { input, first, store, maxSteps: 4 });
    expect(final.status).toBe("completed");
    const original = await getCheckpoint(final.runId, { store, checkpointSeq: 1 });
    const reused = await getCheckpoint(final.runId, { store, checkpointSeq: 3 });
    expect(reused?.committed).toMatchObject({
      reusedFrom: { checkpointSeq: 1, attemptId: original?.committed?.attemptId },
      previousAttemptId: original?.committed?.attemptId,
      outcome,
      artifacts: original?.committed?.artifacts,
    });
    expect(reused?.next).toEqual(alternateScope);
    expect(final.checkpoint.committed?.reusedFrom).toBeNull();
    expect(realScan.mock.calls).toEqual([[first.scope], [alternateScope.scope]]);
  });

  it.each([
    { order: "descending", sequences: [2, 1, 0] },
    { order: "shuffled", sequences: [2, 0, 1] },
  ])("reuses the newest checkpoint when the store lists checkpoints in $order order", async ({ sequences }) => {
    const store = openStore();
    const input = await snapshot(store, "cache-ordering", []);
    const first = work("scan", "scan:evidence", { sourcePaths: [affectedPath] });
    const workflow: DurableWorkflow = {
      workflowKey: "reuse-ordering-fixture",
      revision,
      steps: {
        async scan(ctx) {
          const seq = ctx.checkpoint.checkpointSeq;
          if (seq < 2) {
            const code = seq === 0 ? "older-result" : "newer-result";
            const artifact = await put(ctx, "evidence", code);
            return { outcome: { code }, artifacts: [artifact], next: first };
          }
          const cached = ctx.findReusableWork();
          if (!cached) throw new Error("Expected committed work to reuse.");
          return { reuseFrom: cached.checkpointSeq, next: null };
        },
      },
    };

    const paused = await runDurable(workflow, { input, first, store, maxSteps: 2 });
    expect(paused.status).toBe("interrupted");
    expect(paused.checkpoint.committed?.outcome.code).toBe("newer-result");
    const history = await store.listCheckpoints(paused.runId);
    const checkpoints = new Map(history.map(checkpoint => [checkpoint.checkpointSeq, checkpoint]));
    const list = vi.spyOn(store, "listCheckpoints").mockImplementation(async (runId) => {
      expect(runId).toBe(paused.runId);
      return sequences.map(seq => {
        const checkpoint = checkpoints.get(seq);
        if (!checkpoint) throw new Error("Fixture checkpoint is missing.");
        return checkpoint;
      });
    });

    const final = await resumeDurable(paused.runId, {
      workflow,
      expectedInput: input,
      expectedCheckpointSeq: paused.checkpoint.checkpointSeq,
      store,
    });
    expect(list).toHaveBeenCalled();
    expect(final.status).toBe("completed");
    expect(final.checkpoint.committed).toMatchObject({
      outcome: { code: "newer-result" },
      artifacts: paused.checkpoint.committed?.artifacts,
      reusedFrom: { checkpointSeq: 2, attemptId: paused.checkpoint.committed?.attemptId },
    });
  });

  it("records a nested durable failure at the outer attempt and allows a linked retry", async () => {
    const store = openStore();
    const input = await snapshot(store, "nested-work", []);
    const first = work("prepare", "prepare:outer", null);
    const next = work("collect", "collect:outer", { selector: "TASK_A" });
    const runId = "outer-run";
    const workflow: DurableWorkflow = {
      workflowKey: "nested-error-fixture",
      revision,
      steps: {
        prepare() {
          return { outcome: { code: "prepared" }, next };
        },
        async collect(ctx) {
          if (!ctx.previousAttemptId) {
            await resumeDurable("missing-inner-run", { workflow, expectedInput: input, store });
          }
          return { outcome: { code: "collected" }, next: null };
        },
      },
    };
    const failed = await runDurable(workflow, { input, first, store, runId });
    expect(failed).toMatchObject({
      status: "failed",
      checkpoint: { checkpointSeq: 1, committed: { operationKey: first.operationKey }, next },
      error: { code: "STEP_FAILED", runId, checkpointSeq: 1 },
    });
    expect(await getDurableRun(runId, { store })).toEqual(failed);
    const attempts = await getDurableAttempts(runId, { store });
    expect(attempts[1]).toMatchObject({ work: next, checkpointSeq: 1, committedCheckpointSeq: null, status: "failed" });

    const retry = await resumeDurable(runId, { workflow, expectedInput: input, expectedCheckpointSeq: 1, store });
    expect(retry).toMatchObject({
      status: "completed",
      checkpoint: { checkpointSeq: 2, committed: { previousAttemptId: attempts[1]!.attemptId, outcome: { code: "collected" } } },
    });
  });

});
