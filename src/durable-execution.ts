import { randomUUID } from "node:crypto";
import {
  copyJSON,
  DurableExecutionError,
  hasText,
  isRecord,
  manifestRef,
  readVerifiedArtifact,
  sameRef,
  sameSnapshot,
  stepHandler,
  validateRef,
  validateSnapshot,
  validateWork,
  validateWorkflow,
  workIdentity,
} from "./durable-validation.js";
import { combineAbortSignals } from "./shared/abort.js";
import type {
  DurableArtifactRef,
  DurableAttempt,
  DurableCheckpoint,
  DurableCommittedWork,
  DurableExecutionStore,
  DurableInputChangeOptions,
  DurableOutcome,
  DurableResumeOptions,
  DurableRunOptions,
  DurableRunResult,
  DurableStatus,
  DurableStep,
  DurableStepContext,
  DurableStepResult,
  DurableWork,
  DurableWorkflow,
  SnapshotInput,
} from "./types/durable.js";

type StoreOption = { store: DurableExecutionStore };
type ReusableWork = NonNullable<ReturnType<DurableStepContext["findReusableWork"]>>;
type Catalog = {
  artifacts: Map<string, DurableArtifactRef>;
  reusable: Map<string, ReusableWork>;
};

export async function getCheckpoint(
  runId: string,
  { store, checkpointSeq }: StoreOption & { checkpointSeq?: number },
): Promise<DurableCheckpoint | null> {
  return checkpointSeq === undefined
    ? (await store.readRun(runId))?.checkpoint ?? null
    : store.readCheckpoint(runId, checkpointSeq);
}

export function getDurableRun(runId: string, { store }: StoreOption): Promise<DurableRunResult | null> {
  return store.readRun(runId);
}

export function getDurableAttempts(runId: string, { store }: StoreOption): Promise<readonly DurableAttempt[]> {
  return store.listAttempts(runId);
}

export async function runDurable(workflow: DurableWorkflow, options: DurableRunOptions): Promise<DurableRunResult> {
  validateWorkflow(workflow, null);
  const { store, signal, maxSteps } = options;
  const runId = options.runId ?? randomUUID();
  if (!hasText(runId)) throw new DurableExecutionError("INVALID_INPUT", "Run ID must be a nonempty string.");
  validateLimit(maxSteps, null);
  const input = validateSnapshot(options.input, null);
  const first = validateWork(options.first, workflow, null);
  const catalog = createCatalog(input);
  await verifyArtifacts(store, catalog.artifacts.values(), null);

  const checkpoint: DurableCheckpoint = {
    schemaVersion: 1,
    runId,
    checkpointSeq: 0,
    previousCheckpointSeq: null,
    workflowKey: workflow.workflowKey,
    revision: workflow.revision,
    generation: 0,
    input,
    committed: null,
    next: first,
    inputChange: null,
  };
  if (!await store.createRun(checkpoint)) throw await conflict(store, runId);
  return execute(workflow, store, checkpoint, catalog, signal, maxSteps);
}

export async function resumeDurable(runId: string, options: DurableResumeOptions): Promise<DurableRunResult> {
  const { workflow, expectedCheckpointSeq, store, signal, maxSteps } = options;
  const current = await requireRun(store, runId);
  const checkpoint = current.checkpoint;
  validateHead(workflow, checkpoint, expectedCheckpointSeq);
  validateLimit(maxSteps, checkpoint);

  const expected = validateSnapshot(options.expectedInput, checkpoint);
  if (!sameSnapshot(checkpoint.input, expected)) {
    throw new DurableExecutionError("INPUT_SNAPSHOT_MISMATCH", "Resume requires the committed input snapshot.", checkpoint);
  }

  if (checkpoint.next) validateWork(checkpoint.next, workflow, checkpoint);
  const catalog = await loadCatalog(store, checkpoint);
  await verifyArtifacts(store, catalog.artifacts.values(), checkpoint);
  return checkpoint.next ? execute(workflow, store, checkpoint, catalog, signal, maxSteps) : current;
}

export async function advanceInput(runId: string, options: DurableInputChangeOptions): Promise<DurableCheckpoint> {
  const { workflow, store, expectedCheckpointSeq } = options;
  const { checkpoint } = await requireRun(store, runId);
  if (!Number.isSafeInteger(expectedCheckpointSeq) || expectedCheckpointSeq < 0) {
    throw new DurableExecutionError("INVALID_INPUT", "An input change requires the parent checkpoint sequence.", checkpoint);
  }
  validateHead(workflow, checkpoint, expectedCheckpointSeq);
  const next = validateWork(options.next, workflow, checkpoint);
  const input = validateSnapshot(options.input, checkpoint);
  if (sameSnapshot(input, checkpoint.input)) {
    throw new DurableExecutionError("INVALID_INPUT", "A new generation requires a different input snapshot.", checkpoint);
  }

  const affectedScope = copyJSON(options.affectedScope, checkpoint, "Affected scope", "INVALID_INPUT");
  const catalog = await loadCatalog(store, checkpoint);
  if (!Array.isArray(options.reuseArtifactIds)) {
    throw new DurableExecutionError("INVALID_INPUT", "Reuse artifact IDs must be a list.", checkpoint);
  }
  const reuseArtifactIds = Array.from(new Set(options.reuseArtifactIds));
  const retainedArtifacts = reuseArtifactIds.map(id => {
    const ref = catalog.artifacts.get(id);
    if (!ref) throw new DurableExecutionError("INVALID_INPUT", "Reuse requires a published artifact from the parent generation.", checkpoint, id);
    return ref;
  });

  const reuseById = new Map(retainedArtifacts.map(ref => [ref.id, ref]));
  const newInputRefs = [manifestRef(input), ...input.artifacts];
  for (const ref of newInputRefs) {
    const retained = reuseById.get(ref.id);
    if (retained && !sameRef(ref, retained)) {
      throw new DurableExecutionError("ARTIFACT_MISMATCH", "An input artifact conflicts with the retained reference.", checkpoint, ref.id);
    }
  }
  await verifyArtifacts(store, [...newInputRefs, ...retainedArtifacts], checkpoint);

  return withLease(store, checkpoint, undefined, async (owner, signal) => {
    const updated: DurableCheckpoint = {
      ...checkpoint,
      checkpointSeq: checkpoint.checkpointSeq + 1,
      previousCheckpointSeq: checkpoint.checkpointSeq,
      generation: checkpoint.generation + 1,
      input,
      committed: null,
      inputChange: { affectedScope, reuseArtifactIds, retainedArtifacts },
      next,
    };
    signal.throwIfAborted();
    if (!await store.commit(updated, owner)) throw await conflict(store, runId);
    return updated;
  });
}

function validateLimit(maxSteps: number | undefined, checkpoint: DurableCheckpoint | null): void {
  if (maxSteps !== undefined && (!Number.isSafeInteger(maxSteps) || maxSteps < 1)) {
    throw new DurableExecutionError("INVALID_INPUT", "maxSteps must be a positive safe integer.", checkpoint);
  }
}

function validateHead(workflow: DurableWorkflow, checkpoint: DurableCheckpoint, expectedSeq: number | undefined): void {
  validateWorkflow(workflow, checkpoint);
  if (checkpoint.schemaVersion !== 1) {
    throw new DurableExecutionError("CHECKPOINT_SCHEMA_MISMATCH", "Unsupported durable checkpoint schema.", checkpoint);
  }
  if (expectedSeq !== undefined && expectedSeq !== checkpoint.checkpointSeq) {
    throw new DurableExecutionError("CHECKPOINT_CONFLICT", "Expected checkpoint differs from the committed head.", checkpoint);
  }
  if (workflow.workflowKey !== checkpoint.workflowKey || workflow.revision !== checkpoint.revision) {
    throw new DurableExecutionError("WORKFLOW_REVISION_MISMATCH", "Workflow key or revision differs from the checkpoint.", checkpoint);
  }
}

async function requireRun(store: DurableExecutionStore, runId: string): Promise<DurableRunResult> {
  const current = await store.readRun(runId);
  if (!current) {
    throw new DurableExecutionError("RUN_NOT_FOUND", "Durable run was not found.", { runId, checkpointSeq: null });
  }
  return current;
}

async function conflict(store: DurableExecutionStore, runId: string): Promise<DurableExecutionError> {
  const current = await store.readRun(runId);
  return new DurableExecutionError("CHECKPOINT_CONFLICT", "The run head or executor lease has changed.", current?.checkpoint ?? { runId, checkpointSeq: null });
}

function createCatalog(input: SnapshotInput): Catalog {
  return {
    artifacts: new Map([manifestRef(input), ...input.artifacts].map(ref => [ref.id, ref])),
    reusable: new Map(),
  };
}

function indexCommit(catalog: Catalog, checkpointSeq: number, committed: DurableCommittedWork): void {
  for (const ref of committed.artifacts) catalog.artifacts.set(ref.id, ref);
  const identity = workIdentity(committed);
  const previous = catalog.reusable.get(identity);
  if (!previous || checkpointSeq > previous.checkpointSeq) {
    catalog.reusable.set(identity, { checkpointSeq, committed });
  }
}

async function loadCatalog(store: DurableExecutionStore, checkpoint: DurableCheckpoint): Promise<Catalog> {
  const catalog = createCatalog(checkpoint.input);
  for (const previous of await store.listCheckpoints(checkpoint.runId)) {
    if (previous.generation !== checkpoint.generation || previous.checkpointSeq > checkpoint.checkpointSeq) continue;
    for (const ref of previous.inputChange?.retainedArtifacts ?? []) catalog.artifacts.set(ref.id, ref);
    if (previous.committed) indexCommit(catalog, previous.checkpointSeq, previous.committed);
  }
  return catalog;
}

async function verifyArtifacts(store: DurableExecutionStore, refs: Iterable<DurableArtifactRef>, checkpoint: DurableCheckpoint | null): Promise<void> {
  for (const ref of refs) await readVerifiedArtifact(store, ref, checkpoint);
}

async function withLease<T>(
  store: DurableExecutionStore,
  checkpoint: DurableCheckpoint,
  cancellation: AbortSignal | undefined,
  run: (owner: string, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const { runId } = checkpoint;
  const owner = randomUUID();
  if (!await store.acquire(runId, checkpoint.checkpointSeq, owner)) throw await conflict(store, runId);

  const lostLease = new AbortController();
  const signal = combineAbortSignals([cancellation, lostLease.signal]) ?? lostLease.signal;
  let renewal: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewal || lostLease.signal.aborted) return;
    renewal = (async () => {
      try {
        if (!await store.renew(runId, owner)) lostLease.abort(await conflict(store, runId));
      } catch (error) {
        lostLease.abort(error);
      } finally {
        renewal = undefined;
      }
    })();
  }, Math.max(1, Math.floor(store.leaseMs / 3)));
  heartbeat.unref();

  try {
    return await run(owner, signal);
  } finally {
    clearInterval(heartbeat);
    await renewal;
    await store.release(runId, owner);
  }
}

function runResult(checkpoint: DurableCheckpoint, status: DurableStatus): DurableRunResult {
  return { runId: checkpoint.runId, status, checkpoint, error: null };
}

async function execute(
  workflow: DurableWorkflow,
  store: DurableExecutionStore,
  initial: DurableCheckpoint,
  catalog: Catalog,
  cancellation?: AbortSignal,
  maxSteps?: number,
): Promise<DurableRunResult> {
  return withLease(store, initial, cancellation, async (owner, signal) => {
    let checkpoint = initial;
    let steps = 0;
    while (checkpoint.next) {
      const work = checkpoint.next;
      const handler = stepHandler(workflow, work.stepKey);
      if (signal.aborted) return stopExecution(store, checkpoint, owner, signal.reason, cancellation);
      const attempt = await store.beginAttempt(checkpoint.runId, owner, {
        attemptId: randomUUID(),
        previousAttemptId: null,
        checkpointSeq: checkpoint.checkpointSeq,
        committedCheckpointSeq: null,
        generation: checkpoint.generation,
        work,
        status: "started",
      });
      if (!attempt) throw await conflict(store, checkpoint.runId);

      let changes: Pick<DurableCheckpoint, "committed" | "next">;
      try {
        if (!handler) throw new DurableExecutionError("INVALID_WORK", "No handler registered for step " + work.stepKey + ".", checkpoint);
        changes = await runStep(workflow, handler, store, checkpoint, attempt, catalog, signal);
        signal.throwIfAborted();
      } catch (error) {
        if (signal.aborted && !cancellation?.aborted) throw signal.reason;
        return stopExecution(store, checkpoint, owner, error, cancellation);
      }

      const updated: DurableCheckpoint = {
        ...checkpoint,
        ...changes,
        checkpointSeq: checkpoint.checkpointSeq + 1,
        previousCheckpointSeq: checkpoint.checkpointSeq,
        inputChange: null,
      };
      if (!await store.commit(updated, owner)) throw await conflict(store, checkpoint.runId);
      checkpoint = updated;
      if (changes.committed) indexCommit(catalog, checkpoint.checkpointSeq, changes.committed);
      steps += 1;
      if (checkpoint.next && steps === maxSteps && !signal.aborted) return runResult(checkpoint, "interrupted");
    }
    return runResult(checkpoint, "completed");
  });
}

async function stopExecution(
  store: DurableExecutionStore,
  checkpoint: DurableCheckpoint,
  owner: string,
  cause: unknown,
  cancellation: AbortSignal | undefined,
): Promise<DurableRunResult> {
  const status = cancellation?.aborted ? "cancelled" : "failed";
  const error = status === "failed" && cause instanceof DurableExecutionError
    && cause.runId === checkpoint.runId && cause.checkpointSeq === checkpoint.checkpointSeq
    && (cause.code === "ARTIFACT_MISMATCH" || cause.code === "INVALID_WORK")
    ? cause
    : new DurableExecutionError(
      status === "cancelled" ? "CANCELLED" : "STEP_FAILED",
      cause instanceof Error ? cause.message : hasText(cause) ? cause : "Execution stopped.",
      checkpoint,
    );
  if (!await store.stop(checkpoint.runId, owner, status, error.toJSON())) {
    throw await conflict(store, checkpoint.runId);
  }
  return { ...runResult(checkpoint, status), error: error.toJSON() };
}

async function runStep(
  workflow: DurableWorkflow,
  handler: DurableStep,
  store: DurableExecutionStore,
  checkpoint: DurableCheckpoint,
  attempt: DurableAttempt,
  catalog: Catalog,
  signal: AbortSignal,
): Promise<{ committed: DurableCommittedWork; next: DurableWork | null }> {
  const { work, attemptId, previousAttemptId } = attempt;
  const reusable = catalog.reusable.get(workIdentity(work));
  const staged = new Map<string, DurableArtifactRef>();
  const publishedRef = (id: string) => catalog.artifacts.get(id);
  const availableRef = (id: string) => staged.get(id) ?? publishedRef(id);
  let result: DurableStepResult;
  let active = true;
  try {
    signal.throwIfAborted();
    result = await handler({
      runId: checkpoint.runId,
      checkpoint: structuredClone(checkpoint),
      work: structuredClone(work),
      attemptId,
      previousAttemptId,
      signal,
      findReusableWork: () => reusable ? structuredClone(reusable) : null,
      getArtifactRef: id => {
        const ref = publishedRef(id);
        return ref ? { ...ref } : null;
      },
      async putArtifact(kind, bytes) {
        signal.throwIfAborted();
        if (!active || !hasText(kind) || !(bytes instanceof Uint8Array)) {
          throw new DurableExecutionError("INVALID_WORK", "Active work, artifact kind and bytes are required.", checkpoint);
        }
        const ref = await store.putArtifact(kind, bytes);
        staged.set(ref.id, { ...ref });
        return ref;
      },
      async readArtifact(ref) {
        signal.throwIfAborted();
        if (!active || !ref || !sameRef(ref, availableRef(ref.id))) {
          throw new DurableExecutionError("INVALID_WORK", "Artifact is outside the current work's published or staged references.", checkpoint, ref?.id);
        }
        return readVerifiedArtifact(store, ref, checkpoint);
      },
    });
  } finally {
    active = false;
  }

  if (!result || (result.reuseFrom !== undefined && (result.outcome !== undefined || result.artifacts !== undefined))) {
    throw new DurableExecutionError("INVALID_WORK", "A handler must return new work output or a reuse checkpoint.", checkpoint);
  }
  const next = result.next === null ? null : validateWork(result.next, workflow, checkpoint);
  if (result.reuseFrom !== undefined && result.reuseFrom !== reusable?.checkpointSeq) {
    throw new DurableExecutionError("INVALID_WORK", "Reuse must match committed work in the current generation.", checkpoint);
  }
  const source = result.reuseFrom === undefined ? undefined : reusable;
  const outcome = source?.committed.outcome ?? validateOutcome(result.outcome, checkpoint);
  const output = source?.committed.artifacts ?? result.artifacts ?? [];
  if (!Array.isArray(output)) throw new DurableExecutionError("INVALID_WORK", "Work artifacts must be a list.", checkpoint);
  const refs = new Map<string, DurableArtifactRef>();
  for (const candidate of output) {
    const ref = validateRef(candidate, checkpoint, "INVALID_WORK");
    if (!sameRef(ref, availableRef(ref.id))) {
      throw new DurableExecutionError("INVALID_WORK", "Work can publish only its staged or already published artifacts.", checkpoint, ref.id);
    }
    refs.set(ref.id, ref);
  }
  for (const id of [outcome.detailsRef, outcome.coverageRef]) {
    if (id === undefined) continue;
    const ref = refs.get(id) ?? publishedRef(id);
    if (!ref) throw new DurableExecutionError("INVALID_WORK", "Outcome points to an unpublished artifact.", checkpoint, id);
    refs.set(id, ref);
  }
  await verifyArtifacts(store, refs.values(), checkpoint);
  return {
    committed: {
      ...work,
      attemptId,
      previousAttemptId,
      artifacts: [...refs.values()],
      outcome,
      reusedFrom: source ? { checkpointSeq: source.checkpointSeq, attemptId: source.committed.attemptId } : null,
    },
    next,
  };
}

function validateOutcome(value: DurableOutcome | undefined, checkpoint: DurableCheckpoint): DurableOutcome {
  if (!isRecord(value) || !hasText(value.code)
      || (value.detailsRef !== undefined && !hasText(value.detailsRef))
      || (value.coverageRef !== undefined && !hasText(value.coverageRef))) {
    throw new DurableExecutionError("INVALID_WORK", "An outcome requires a code and valid artifact IDs if provided.", checkpoint);
  }
  return copyJSON(value, checkpoint, "Outcome") as DurableOutcome;
}
