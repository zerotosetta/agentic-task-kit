import { createHash } from "node:crypto";
import {
  resumeDurable,
  runDurable,
} from "../../src/durable-execution.js";
import { SqliteDurableExecutionStore } from "../../src/durable-store.js";
import { DurableExecutionError } from "../../src/durable-validation.js";
import type {
  DurableArtifactRef,
  DurableErrorDetails,
  DurableJSON,
  DurableRunResult,
  DurableStep,
  DurableStepContext,
  DurableWork,
  DurableWorkflow,
  SnapshotInput,
} from "../../src/types/durable.js";

export type FixtureEvent =
  | { type: "work"; operationKey: string }
  | { type: "paused"; artifact: DurableArtifactRef; attemptId: string }
  | { type: "result"; result: DurableRunResult }
  | { type: "rejected"; error: DurableErrorDetails };

const snapshotId = "fixture-snapshot-01";
const revision = "static-fixture-v2";
const scope = {
  selector: { kind: "Query", key: "fixture.lookup" },
  provider: "test-metadata",
  version: snapshotId,
};
const pageCursor = { selector: scope.selector, version: snapshotId, token: "fixture-page-2" };

function bytes(value: DurableJSON) {
  return Buffer.from(JSON.stringify(value));
}

function work(stepKey: string, operationKey: string, cursor?: DurableJSON): DurableWork {
  return {
    stepKey,
    operationKey,
    scope,
    cacheFingerprint: createHash("sha256").update(bytes({ scope, revision, cursor: cursor ?? null })).digest("hex"),
    ...(cursor !== undefined ? { cursor } : {}),
  };
}

function send(event: FixtureEvent) {
  return new Promise<void>((resolve, reject) => {
    if (!process.send) {
      reject(new Error("Durable process fixture requires an IPC channel."));
      return;
    }
    process.send(event, (error: Error | null) => error ? reject(error) : resolve());
  });
}

function recordStep(step: DurableStep): DurableStep {
  return async (context) => {
    await send({ type: "work", operationKey: context.work.operationKey });
    return step(context);
  };
}

async function pauseAfterArtifact(context: DurableStepContext) {
  const artifact = await context.putArtifact("uncommitted-page", bytes({ temporary: true }));
  const proceed = new Promise<void>((resolve) => { process.once("message", () => resolve()); });
  await send({ type: "paused", artifact, attemptId: context.attemptId });
  await proceed;
}

const [databasePath, action, pauseAt, expectedSeq, expectedInput] = process.argv.slice(2);
if (!databasePath || (action !== "start" && action !== "prepare" && action !== "resume")) {
  throw new Error("Expected SQLite path and start, prepare, or resume action.");
}

const workflow: DurableWorkflow = {
  workflowKey: "paged-fixture",
  revision,
  steps: {
    entry: recordStep(() => ({ outcome: { code: "entry-loaded" }, next: work("discover", "discover") })),
    discover: recordStep(() => ({ outcome: { code: "keys-found" }, next: work("collect", "collect:page1") })),
    collect: recordStep(async (context) => {
      if (context.work.operationKey === pauseAt) await pauseAfterArtifact(context);
      if (context.work.operationKey === "collect:page1") {
        const coverage = { requested: 2, observed: 1, complete: false };
        const page = await context.putArtifact("metadata-page", bytes({
          source: { provider: scope.provider, version: scope.version },
          cells: [{ key: "fixture.lookup", status: "found" }],
          cursor: pageCursor,
        }));
        const summary = await context.putArtifact("coverage", bytes(coverage));
        return {
          artifacts: [page, summary],
          outcome: {
            code: "page-captured",
            detailsRef: page.id,
            coverageRef: summary.id,
            coverage,
            cursor: pageCursor,
          },
          next: work("collect", "collect:page2", pageCursor),
        };
      }

      const firstPage = context.checkpoint.committed?.artifacts[0];
      if (!firstPage) throw new Error("Expected the first metadata page in the previous checkpoint.");
      const prior = JSON.parse(Buffer.from(await context.readArtifact(firstPage)).toString("utf8")) as Record<string, DurableJSON>;
      const coverage = { requested: 2, observed: 1, complete: false };
      const page = await context.putArtifact("metadata-page", bytes({
        source: prior.source ?? null,
        cells: [{ key: "fixture.external", status: "not-captured" }],
        cursor: null,
      }));
      return {
        artifacts: [page],
        outcome: {
          code: "collected-partial",
          detailsRef: page.id,
          coverage,
          cursor: null,
          issues: [{ code: "not-captured", key: "fixture.external" }],
        },
        next: work("static", "static"),
      };
    }),
    static: recordStep(async (context) => {
      if (context.work.operationKey === pauseAt) await pauseAfterArtifact(context);
      return { outcome: { code: "analysis-complete" }, next: null };
    }),
  },
};

const store = new SqliteDurableExecutionStore(databasePath, { leaseMs: 3_000 });
try {
  const runId = "fixture-run";
  let result: DurableRunResult;
  if (action !== "resume") {
    const manifest = await store.putArtifact("manifest", bytes({ snapshotId, selector: scope.selector }));
    result = await runDurable(workflow, {
      input: { snapshotId, manifestId: manifest.id, sha256: manifest.sha256, artifacts: [] },
      first: work("entry", "entry"),
      runId,
      store,
      ...(action === "prepare" ? { maxSteps: 4 } : {}),
    });
  } else {
    if (!expectedSeq || !expectedInput) throw new Error("Expected resume sequence and input.");
    result = await resumeDurable(runId, {
      workflow,
      expectedCheckpointSeq: Number(expectedSeq),
      expectedInput: JSON.parse(expectedInput) as SnapshotInput,
      store,
    });
  }
  await send({ type: "result", result });
} catch (error) {
  if (!(error instanceof DurableExecutionError)) throw error;
  await send({
    type: "rejected",
    error: {
      code: error.code,
      message: error.message,
      runId: error.runId,
      checkpointSeq: error.checkpointSeq,
      artifactId: error.artifactId,
    },
  });
} finally {
  store.close();
  process.disconnect?.();
}
