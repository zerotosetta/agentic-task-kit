import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteDurableExecutionStore } from "../src/durable-store.js";
import { definePipeline, runPipeline } from "../src/pipeline.js";
import type { DurableExecutionStore, DurableJSON, DurableWork } from "../src/types/durable.js";

const scopeSchema = { type: "string" } as const;
const outcomeSchema = {
  type: "object", required: ["code", "count"],
  properties: { code: { type: "string" }, count: { type: "integer" } },
} as const;

function work(stepKey: string, scope: DurableJSON = "east"): DurableWork {
  const cacheFingerprint = createHash("sha256").update(JSON.stringify([stepKey, scope, "rules-v1"])).digest("hex");
  return { stepKey, scope, operationKey: stepKey + "/" + cacheFingerprint, cacheFingerprint };
}

async function snapshot(store: DurableExecutionStore, fingerprint: string, edition: number) {
  const bytes = Buffer.from(JSON.stringify({ fingerprint, edition }));
  const ref = await store.putArtifact("manifest", bytes);
  return { snapshotId: "edition-" + edition, manifestId: ref.id, sha256: ref.sha256, artifacts: [] };
}

let stateDirectory: string;
beforeEach(() => { stateDirectory = mkdtempSync(join(tmpdir(), "atk-domain-test-")); });
afterEach(() => { rmSync(stateDirectory, { recursive: true, force: true }); });

describe("durable pipeline declarations", () => {
  it("restores domain work, advances its pinned input and publishes the domain report", async () => {
    const calls: string[] = [];
    function declare(ready: boolean) {
      return definePipeline({
        mode: "durable", key: "audit", description: "Audit one region", revision: "v1",
        inputSchema: scopeSchema, outputSchema: outcomeSchema,
        steps: [
          { key: "scan", inputSchema: scopeSchema, outputSchema: outcomeSchema, allowedNext: ["index"],
            async run(ctx) {
              calls.push(ctx.work.stepKey);
              const ref = await ctx.putArtifact("audit/source", Buffer.from("E-42"));
              return { artifacts: [ref], outcome: { code: "scanned", count: 1 }, next: work("index", ref.id) };
            } },
          { key: "index", internal: true, inputSchema: scopeSchema, outputSchema: outcomeSchema, allowedNext: ["report"],
            async run(ctx) {
              calls.push(ctx.work.stepKey);
              const source = ctx.getArtifactRef(String(ctx.work.scope));
              if (!source) throw new Error("Missing retained source");
              const bytes = await ctx.readArtifact(source);
              return { outcome: { code: "indexed", count: 1 }, next: work("report", Buffer.from(bytes).toString()) };
            } },
          { key: "report", inputSchema: scopeSchema, outputSchema: outcomeSchema, allowedNext: [null],
            async run(ctx) {
              calls.push(ctx.work.stepKey);
              const ref = await ctx.putArtifact("audit/report", Buffer.from("Reviewed " + ctx.work.scope));
              return { artifacts: [ref], outcome: { code: "reviewed", count: 1, detailsRef: ref.id }, next: null };
            } },
        ],
        async bind(host, fingerprint) {
          const input = host.checkpoint?.input ?? await snapshot(host.store, fingerprint, 1);
          const bytes = await host.store.readArtifact(input.manifestId);
          if (!bytes || JSON.parse(Buffer.from(bytes).toString()).fingerprint !== fingerprint) {
            throw new Error("The audit definition differs from its pinned manifest");
          }
          return {
            input,
            first: work("scan"),
            pauseBefore: ({ checkpoint }) => !ready && checkpoint.next?.stepKey === "index",
            async prepareNext({ checkpoint }) {
              const next = checkpoint.next;
              if (checkpoint.generation !== 0 || next?.stepKey !== "index") return null;
              return { input: await snapshot(host.store, fingerprint, 2), affectedScope: "east",
                reuseArtifactIds: [String(next.scope)], next };
            },
            planRerun: ({ request }) => work(request.stepKey, request.scope.ticket ?? "east"),
          };
        },
      });
    }
    const first = declare(false);
    expect(first.descriptor.steps).toEqual([
      expect.objectContaining({ key: "scan", allowedNext: ["index"] }),
      expect.objectContaining({ key: "index", internal: true, allowedNext: ["report"] }),
      expect.objectContaining({ key: "report", allowedNext: [null] }),
    ]);
    expect(first.descriptor.stageOrder).toEqual(["scan", "report"]);
    const paused = await runPipeline(first, "east", { stateDirectory });
    expect(paused).toMatchObject({ status: "interrupted", checkpoint: { generation: 0, next: { stepKey: "index" } } });
    const resume = { stateDirectory, runId: paused.runId, resume: true };
    const done = await runPipeline(declare(true), "east", resume);
    expect(done).toMatchObject({ runId: paused.runId, status: "completed", checkpoint: {
      generation: 1, input: { snapshotId: "edition-2" }, committed: { outcome: { code: "reviewed", count: 1 } },
    } });
    expect(calls).toEqual(["scan", "index", "report"]);
    const store = new SqliteDurableExecutionStore(join(stateDirectory, "execution.sqlite"));
    try {
      const ref = done.checkpoint.committed!.artifacts[0]!;
      expect(ref.kind).toBe("audit/report");
      expect(done.checkpoint.committed?.outcome.detailsRef).toBe(ref.id);
      expect(Buffer.from((await store.readArtifact(ref.id))!).toString()).toBe("Reviewed E-42");
      const manifest = await store.readArtifact(done.checkpoint.input.manifestId);
      expect(JSON.parse(Buffer.from(manifest!).toString())).toEqual({ fingerprint: first.fingerprint, edition: 2 });
    } finally { store.close(); }
    const rerun = { id: "report-again", stepKey: "report", expectedCheckpointSeq: done.checkpoint.checkpointSeq,
      scope: { ticket: "E-55" }, params: {} };
    const repeated = await runPipeline(declare(true), "east", { ...resume, rerun });
    expect(repeated.checkpoint.committed?.scope).toBe("E-55");
    expect(repeated.status).toBe("completed");
    expect(calls).toEqual(["scan", "index", "report", "report"]);
  });

  it.each(["route", "next scope", "outcome"] as const)("refuses an invalid %s before publishing work", async invalid => {
    const calls: string[] = [];
    const pipeline = definePipeline({
      mode: "durable", key: "checked", description: "Check work", revision: "1",
      inputSchema: scopeSchema, outputSchema: outcomeSchema,
      steps: [
        { key: "check", inputSchema: scopeSchema, outputSchema: outcomeSchema, allowedNext: ["finish"],
          run() {
            calls.push("check");
            const next = work(invalid === "route" ? "check" : "finish", invalid === "next scope" ? 3 : "east");
            return { outcome: { code: "checked", count: invalid === "outcome" ? "many" : 1 }, next };
          } },
        { key: "finish", inputSchema: scopeSchema, outputSchema: outcomeSchema, allowedNext: [null],
          run() { calls.push("finish"); return { outcome: { code: "finished", count: 1 }, next: null }; } },
      ],
      async bind(host, fingerprint) {
        return { input: await snapshot(host.store, fingerprint, 1), first: work("check") };
      },
    });
    const result = await runPipeline(pipeline, "east", { stateDirectory, maxSteps: 2 });
    expect(result.status).toBe("failed");
    expect(result.checkpoint.committed).toBeNull();
    expect(calls).toEqual(["check"]);
  });
});
