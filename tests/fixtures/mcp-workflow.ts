import { createHash } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  DurableExecutionStore,
  DurableJSON,
  DurableStepContext,
  DurableWork,
  DurableWorkflow,
  SnapshotInput,
} from "../../src/types/durable.js";
import type { McpWorkflowContext, McpWorkflowPlan } from "../../src/types/mcp.js";

export const evidenceBytes = "ATK result fixture: 가나다 🎯";

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function waitForRelease(path: string, cancellation: AbortSignal): Promise<void> {
  const signal = AbortSignal.any([cancellation, AbortSignal.timeout(40_000)]);
  for (;;) {
    signal.throwIfAborted();
    try {
      await access(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(50, undefined, { signal });
  }
}

function work(stepKey: string, revision: string, cursor?: DurableJSON): DurableWork {
  return {
    stepKey,
    operationKey: "fixture:" + stepKey,
    cacheFingerprint: sha(JSON.stringify([revision, stepKey, cursor ?? null])),
    scope: { path: "/fixture/page.jsp" },
    ...(cursor === undefined ? {} : { cursor }),
  };
}

async function snapshot(store: DurableExecutionStore, id: string, content: DurableJSON): Promise<SnapshotInput> {
  const manifest = await store.putArtifact("manifest", Buffer.from(JSON.stringify(content)));
  return { snapshotId: id, manifestId: manifest.id, sha256: manifest.sha256, artifacts: [] };
}

export async function createWorkflow({
  runId, workDirectory, profile, request, store, checkpoint, signal,
}: McpWorkflowContext): Promise<McpWorkflowPlan> {
  signal.throwIfAborted();
  const mode = request.mode;
  const settings = profile.settings as { controlDirectory: string };
  if (typeof settings.controlDirectory !== "string") throw new Error("Fixture control directory is required.");
  await mkdir(workDirectory, { recursive: true });
  const controlFile = (suffix: string) => join(settings.controlDirectory, `${runId}.${suffix}`);
  if (mode === "generation" && checkpoint) await writeFile(controlFile("factory-resume"), "");
  const first = work("collect", profile.revision);
  const input = checkpoint?.input ?? await snapshot(store, "snapshot-1", { mode: mode ?? null, subject: request.subject ?? null });
  const finish = work("finish", profile.revision);

  async function pauseFirstAttempt(context: DurableStepContext) {
    if (context.previousAttemptId !== null) return;
    const orphan = await context.putArtifact("uncommitted", Buffer.from("orphan-byte-fixture"));
    await writeFile(controlFile("paused.json"), JSON.stringify({
      pid: process.pid,
      attemptId: context.attemptId,
      artifactId: orphan.id,
      workDirectory,
    }), "utf8");
    await waitForRelease(controlFile("release"), context.signal);
  }

  const workflow: DurableWorkflow = {
    workflowKey: "mcp-durable-fixture",
    revision: profile.revision,
    steps: {
      async collect(context) {
        const artifact = await context.putArtifact("fixture-page", Buffer.from("page-one"));
        return {
          artifacts: [artifact],
          outcome: { code: "collected", detailsRef: artifact.id, coverage: { count: 1, complete: false } },
          next: mode === "generation" ? work("prepare-input", profile.revision) : finish,
        };
      },
      async finish(context) {
        if (mode === "fail") throw new Error("Fixture terminal failure.");
        if (context.work.operationKey.startsWith("fixture:rerun:")) {
          const scope = context.work.scope as { sourcePaths: string[]; label: string; pause: boolean };
          if (scope.pause) await pauseFirstAttempt(context);
          const bytes = JSON.stringify({ sourcePaths: scope.sourcePaths, label: scope.label });
          const artifact = await context.putArtifact("fixture-rerun", Buffer.from(bytes));
          return {
            artifacts: [artifact],
            outcome: { code: "rerun-verified", detailsRef: artifact.id, scope, previousAttemptId: context.previousAttemptId },
            next: null,
          };
        }
        if (mode === "wait") await pauseFirstAttempt(context);
        const result = await context.putArtifact("fixture-spec", Buffer.from(evidenceBytes));
        return {
          artifacts: [result],
          outcome: {
            code: "verified",
            detailsRef: result.id,
            previousAttemptId: context.previousAttemptId,
            coverage: { count: 2, complete: true },
            workDirectory,
          },
          next: null,
        };
      },
      "prepare-input": () => {
        throw new Error("Runner must apply the input transition before calling this sentinel.");
      },
      async "finish-transition"(context: DurableStepContext) {
        const retainedId = (context.work.cursor as { retainedId: string }).retainedId;
        const artifact = context.getArtifactRef(retainedId);
        if (!artifact) throw new Error("Transition lost the explicitly retained evidence.");
        const original = Buffer.from(await context.readArtifact(artifact)).toString("utf8");
        return {
          artifacts: [artifact],
          outcome: { code: "generation-checked", generation: context.checkpoint.generation, original },
          next: null,
        };
      },
    },
  };
  return {
    workflow,
    input,
    first,
    async planRerun({ checkpoint: head, request: rerun, signal: planSignal }) {
      const { sourcePaths } = rerun.scope;
      const { label, pause, pausePlanning } = rerun.params;
      if (rerun.stepKey !== "finish" || !Array.isArray(sourcePaths)
        || !sourcePaths.every((path): path is string => typeof path === "string")
        || typeof label !== "string" || (pause !== undefined && typeof pause !== "boolean")
        || (pausePlanning !== undefined && typeof pausePlanning !== "boolean")) {
        throw Object.assign(new Error("Fixture rerun requires finish, sourcePaths, and a label."), { code: "FIXTURE_RERUN_INVALID" });
      }
      if (pausePlanning) {
        await writeFile(controlFile("planning.json"), JSON.stringify({ pid: process.pid }));
        await waitForRelease(controlFile("accept-plan"), planSignal);
      }
      const scope = { sourcePaths: [...new Set(sourcePaths)].sort(), label, pause: pause ?? false };
      return {
        stepKey: rerun.stepKey,
        operationKey: "fixture:rerun:" + rerun.id,
        scope,
        cacheFingerprint: sha(JSON.stringify([profile.revision, head.input.sha256, rerun.stepKey, scope])),
      };
    },
    async prepareNext({ checkpoint: head, signal: hookSignal }) {
      if (head.next?.stepKey !== "prepare-input") return null;
      hookSignal.throwIfAborted();
      await writeFile(controlFile("prepare-next"), "");
      const retained = head.committed?.artifacts[0];
      if (!retained) throw new Error("Missing previous generation artifact.");
      const updated = await snapshot(store, "snapshot-2", { previous: head.input.sha256, retained: retained.sha256 });
      const scope = { sourcePaths: ["/fixture/page.jsp"], reason: "new dependency" };
      return {
        input: updated,
        affectedScope: scope,
        reuseArtifactIds: [retained.id],
        next: { ...work("finish-transition", profile.revision, { retainedId: retained.id }), scope },
      };
    },
  };
}
