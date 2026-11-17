import { readVerifiedArtifact, isRecord } from "../durable-validation.js";
import type { DurableArtifactRef, DurableExecutionStore, DurableRunResult } from "../types/durable.js";
import { McpWorkflowError } from "./config.js";

export const maxMcpResultBytes = 262_144;
const defaultMcpResultBytes = 65_536;

interface Cursor {
  v: 1;
  runId: string;
  checkpointSeq: number;
  artifactId: string | null;
  offset: number;
}

function encode(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function decode(value: string, runId: string, artifactId: string | null): Cursor {
  try {
    if (value.length > 4096 || !/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error();
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (isRecord(parsed) && parsed.v === 1 && parsed.runId === runId && parsed.artifactId === artifactId
        && typeof parsed.checkpointSeq === "number" && Number.isSafeInteger(parsed.checkpointSeq) && parsed.checkpointSeq >= 0
        && typeof parsed.offset === "number" && Number.isSafeInteger(parsed.offset) && parsed.offset >= 0) {
      return { v: 1, runId, artifactId, checkpointSeq: parsed.checkpointSeq, offset: parsed.offset };
    }
  } catch {
    // All malformed cursors use the same public error.
  }
  throw new McpWorkflowError("INVALID_CURSOR", "Results cursor does not match this request.");
}

function insufficientBudget(): never {
  throw new McpWorkflowError("BYTE_LIMIT_TOO_SMALL", "maxBytes is too small for the next result entry.");
}

function metadataPage(base: { runId: string; checkpointSeq: number | null }, refs: DurableArtifactRef[], cursor: Cursor | null, maxBytes: number) {
  const start = cursor?.offset ?? 0;
  if (start > refs.length) throw new McpWorkflowError("INVALID_CURSOR", "Results cursor is past the end of the artifact list.");
  const artifacts: DurableArtifactRef[] = [];
  const emptyPage = { ...base, artifacts, nextCursor: null };
  const emptyBytes = Buffer.byteLength(JSON.stringify(emptyPage));
  if (emptyBytes > maxBytes) insufficientBudget();
  let itemBytes = 0;
  let nextCursor: string | null = null;
  for (let index = start; index < refs.length; index += 1) {
    const ref = refs[index]!;
    const candidate = cursor && index + 1 < refs.length ? encode({ ...cursor, offset: index + 1 }) : null;
    const candidateBytes = itemBytes + Buffer.byteLength(JSON.stringify(ref)) + Number(artifacts.length > 0);
    const cursorBytes = candidate ? Buffer.byteLength(candidate) + 2 - 4 : 0;
    if (emptyBytes + candidateBytes + cursorBytes > maxBytes) {
      if (!artifacts.length) insufficientBudget();
      break;
    }
    artifacts.push(ref);
    itemBytes = candidateBytes;
    nextCursor = candidate;
  }
  return { ...base, artifacts, nextCursor };
}

export async function readResults(
  store: DurableExecutionStore,
  runId: string,
  current: DurableRunResult | null,
  options: { artifactId?: string; cursor?: string; maxBytes?: number },
  signal: AbortSignal,
) {
  const maxBytes = options.maxBytes ?? defaultMcpResultBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > maxMcpResultBytes) {
    throw new McpWorkflowError("INVALID_ARGUMENT", "maxBytes must be a whole number of bytes from 1 to " + maxMcpResultBytes + ".");
  }
  const artifactId = options.artifactId ?? null;
  const fromCursor = options.cursor === undefined ? null : decode(options.cursor, runId, artifactId);
  const head = current?.checkpoint.checkpointSeq ?? null;
  const checkpointSeq = fromCursor?.checkpointSeq ?? head;
  if (fromCursor && (head === null || fromCursor.checkpointSeq > head)) {
    throw new McpWorkflowError("INVALID_CURSOR", "Results cursor points to an unavailable checkpoint.");
  }
  const base = { runId, checkpointSeq };
  const cursor: Cursor | null = checkpointSeq === null
    ? null
    : { v: 1, runId, checkpointSeq, artifactId, offset: fromCursor?.offset ?? 0 };
  const refs = new Map<string, DurableArtifactRef>();
  if (checkpointSeq !== null) {
    signal.throwIfAborted();
    const checkpoints = [...await store.listCheckpoints(runId)].sort((a, b) => a.checkpointSeq - b.checkpointSeq);
    for (const checkpoint of checkpoints) {
      if (checkpoint.checkpointSeq > checkpointSeq) break;
      for (const ref of checkpoint.committed?.artifacts ?? []) refs.set(ref.id, ref);
    }
  }
  signal.throwIfAborted();
  if (artifactId === null) return metadataPage(base, [...refs.values()], cursor, maxBytes);
  const artifact = refs.get(artifactId);
  if (!artifact || !cursor) throw new McpWorkflowError("ARTIFACT_NOT_FOUND", "Artifact has not been published in this run at the selected checkpoint.");
  const bytes = await readVerifiedArtifact(store, artifact, { runId, checkpointSeq });
  signal.throwIfAborted();
  const { offset } = cursor;
  if (offset > bytes.length) throw new McpWorkflowError("INVALID_CURSOR", "Results cursor is past the end of the artifact.");
  const end = Math.min(offset + maxBytes, bytes.length);
  return {
    ...base,
    artifact,
    offset,
    totalBytes: bytes.length,
    data: Buffer.from(bytes.subarray(offset, end)).toString("base64"),
    nextCursor: end === bytes.length ? null : encode({ ...cursor, offset: end }),
  };
}
