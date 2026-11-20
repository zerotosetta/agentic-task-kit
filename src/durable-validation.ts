import { createHash } from "node:crypto";
import { isNonRecoverableFailure, normalizeFailure } from "./durable-errors.js";
import type {
  DurableArtifactRef,
  DurableCheckpoint,
  DurableErrorCause,
  DurableErrorCode,
  DurableErrorDetails,
  DurableExecutionStore,
  DurableJSON,
  DurableWork,
  DurableWorkflow,
  SnapshotInput,
} from "./types/durable.js";

type Position = { runId: string; checkpointSeq: number | null } | null;
const sha256Pattern = /^[0-9a-f]{64}$/u;

export class DurableExecutionError extends Error implements DurableErrorDetails {
  readonly code: DurableErrorCode;
  declare readonly cause?: DurableErrorCause;
  readonly recoverable?: boolean;
  readonly runId: string | null;
  readonly checkpointSeq: number | null;
  readonly artifactId: string | null;

  constructor(code: DurableErrorCode, message: string, position: Position = null, artifactId: string | null = null) {
    super(message);
    this.name = "DurableExecutionError";
    this.code = code;
    this.runId = position?.runId ?? null;
    this.checkpointSeq = position?.checkpointSeq ?? null;
    this.artifactId = artifactId;
    if (isNonRecoverableFailure(this)) this.recoverable = false;
  }

  toJSON(): DurableErrorDetails {
    return {
      ...normalizeFailure(this, this.code),
      code: this.code,
      runId: this.runId,
      checkpointSeq: this.checkpointSeq,
      artifactId: this.artifactId,
    };
  }
}

export function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && sha256Pattern.test(value);
}

export function copyJSON(value: unknown, position: Position, field: string, code: "INVALID_WORK" | "INVALID_INPUT" = "INVALID_WORK"): DurableJSON {
  const ancestors = new Set<object>();
  function copy(entry: unknown): DurableJSON {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number" && Number.isFinite(entry)) return entry === 0 ? 0 : entry;
    if (typeof entry !== "object" || entry === null || ancestors.has(entry)) {
      throw new DurableExecutionError(code, field + " must be JSON data.", position);
    }
    ancestors.add(entry);
    try {
      if (Array.isArray(entry)) return Array.from(entry, copy);
      if (isRecord(entry)) {
        return Object.fromEntries(Object.entries(entry).map(([key, item]) => [key, copy(item)]));
      }
      throw new DurableExecutionError(code, field + " must be JSON data.", position);
    } finally {
      ancestors.delete(entry);
    }
  }
  return copy(value);
}

export function canonicalJSON(value: DurableJSON): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    isRecord(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry,
  );
}

export function workIdentity(work: DurableWork): string {
  return canonicalJSON([work.stepKey, work.operationKey, work.cacheFingerprint, work.scope, work.cursor ?? null, work.cursor !== undefined]);
}

export function validateWorkflow(workflow: DurableWorkflow, position: Position): void {
  if (!hasText(workflow?.workflowKey) || !hasText(workflow.revision) || !isRecord(workflow.steps)) {
    throw new DurableExecutionError("INVALID_INPUT", "A workflow requires a key, revision and step handlers.", position);
  }
}

export function stepHandler(workflow: DurableWorkflow, stepKey: string) {
  return Object.hasOwn(workflow.steps, stepKey) ? workflow.steps[stepKey] : undefined;
}

export function validateWork(work: DurableWork, workflow: DurableWorkflow, position: Position): DurableWork {
  if (!hasText(work?.stepKey) || !hasText(work.operationKey) || !isSha256(work.cacheFingerprint)) {
    throw new DurableExecutionError("INVALID_WORK", "Work requires a step key, operation key and lowercase SHA-256 fingerprint.", position);
  }
  if (typeof stepHandler(workflow, work.stepKey) !== "function") {
    throw new DurableExecutionError("INVALID_WORK", "No handler registered for step " + work.stepKey + ".", position);
  }
  return {
    stepKey: work.stepKey,
    operationKey: work.operationKey,
    cacheFingerprint: work.cacheFingerprint,
    scope: copyJSON(work.scope, position, "Work scope"),
    ...(work.cursor === undefined ? {} : { cursor: copyJSON(work.cursor, position, "Work cursor") }),
  };
}

export function validateRef(ref: DurableArtifactRef, position: Position, code: "INVALID_INPUT" | "INVALID_WORK"): DurableArtifactRef {
  if (!hasText(ref?.id) || !hasText(ref.kind) || !isSha256(ref.sha256)) {
    throw new DurableExecutionError(code, "An artifact requires an ID, kind and lowercase SHA-256.", position);
  }
  return { kind: ref.kind, id: ref.id, sha256: ref.sha256 };
}

export function manifestRef(input: SnapshotInput): DurableArtifactRef {
  return { kind: "manifest", id: input.manifestId, sha256: input.sha256 };
}

export function validateSnapshot(input: SnapshotInput, position: Position): SnapshotInput {
  if (!hasText(input?.snapshotId) || !hasText(input.manifestId) || !isSha256(input.sha256) || !Array.isArray(input.artifacts)) {
    throw new DurableExecutionError("INVALID_INPUT", "Input requires a snapshot ID, manifest ID, lowercase SHA-256 and artifact list.", position);
  }
  const seen = new Set([input.manifestId]);
  const artifacts = Array.from(input.artifacts, ref => {
    const validated = validateRef(ref, position, "INVALID_INPUT");
    if (seen.has(validated.id)) {
      throw new DurableExecutionError("INVALID_INPUT", "Duplicate artifact ID in the input snapshot.", position, validated.id);
    }
    seen.add(validated.id);
    return validated;
  });
  return { snapshotId: input.snapshotId, manifestId: input.manifestId, sha256: input.sha256, artifacts };
}

export function sameSnapshot(a: SnapshotInput, b: SnapshotInput): boolean {
  const byId = new Map(b.artifacts.map(ref => [ref.id, ref]));
  return a.snapshotId === b.snapshotId && a.manifestId === b.manifestId && a.sha256 === b.sha256
    && a.artifacts.length === b.artifacts.length
    && a.artifacts.every(ref => sameRef(ref, byId.get(ref.id)));
}

export function sameRef(ref: DurableArtifactRef, known: DurableArtifactRef | undefined): boolean {
  return known !== undefined && ref.id === known.id && ref.kind === known.kind && ref.sha256 === known.sha256;
}

export async function readVerifiedArtifact(
  store: DurableExecutionStore,
  ref: DurableArtifactRef,
  position: Position,
): Promise<Uint8Array> {
  const bytes = await store.readArtifact(ref.id);
  if (bytes === null || sha256(bytes) !== ref.sha256) {
    throw new DurableExecutionError("ARTIFACT_MISMATCH", "Artifact is missing or its SHA-256 differs from the checkpoint.", position, ref.id);
  }
  return bytes;
}
