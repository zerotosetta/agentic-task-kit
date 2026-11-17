export type DurableJSON =
  | null
  | boolean
  | number
  | string
  | readonly DurableJSON[]
  | { readonly [key: string]: DurableJSON };

export interface DurableArtifactRef {
  kind: string;
  id: string;
  sha256: string;
}

export interface SnapshotInput {
  snapshotId: string;
  /** The ID and SHA-256 identify the original manifest bytes in the store. */
  manifestId: string;
  sha256: string;
  artifacts: readonly DurableArtifactRef[];
}

export interface DurableWork {
  stepKey: string;
  operationKey: string;
  scope: DurableJSON;
  /** Identifies the actual dependencies and rules for this work. */
  cacheFingerprint: string;
  cursor?: DurableJSON;
}

export interface DurableOutcome {
  code: string;
  issues?: DurableJSON;
  coverage?: DurableJSON;
  cursor?: DurableJSON;
  detailsRef?: string;
  coverageRef?: string;
  [key: string]: DurableJSON | undefined;
}

export type DurableStepResult = { next: DurableWork | null } & (
  | { outcome: DurableOutcome; artifacts?: readonly DurableArtifactRef[]; reuseFrom?: never }
  | { reuseFrom: number; outcome?: never; artifacts?: never }
);

export interface DurableCommittedWork extends DurableWork {
  attemptId: string;
  previousAttemptId: string | null;
  artifacts: readonly DurableArtifactRef[];
  outcome: DurableOutcome;
  reusedFrom: { checkpointSeq: number; attemptId: string } | null;
}

export interface DurableInputChange {
  affectedScope: DurableJSON;
  reuseArtifactIds: readonly string[];
  retainedArtifacts: readonly DurableArtifactRef[];
}

/** A caller request and the head it explicitly selected for stage re-execution. */
export interface DurableRerun {
  id: string;
  expectedCheckpointSeq: number;
  stepKey: string;
  scope: Readonly<Record<string, DurableJSON>>;
  params: Readonly<Record<string, DurableJSON>>;
}

export interface DurableCheckpoint {
  schemaVersion: 1;
  runId: string;
  checkpointSeq: number;
  previousCheckpointSeq: number | null;
  workflowKey: string;
  revision: string;
  generation: number;
  input: SnapshotInput;
  committed: DurableCommittedWork | null;
  next: DurableWork | null;
  inputChange: DurableInputChange | null;
  rerun?: DurableRerun;
}

export type DurableStatus = "running" | "interrupted" | "cancelled" | "failed" | "completed";

export type DurableErrorCode =
  | "RUN_NOT_FOUND"
  | "INVALID_INPUT"
  | "INVALID_WORK"
  | "INPUT_SNAPSHOT_MISMATCH"
  | "WORKFLOW_REVISION_MISMATCH"
  | "ARTIFACT_MISMATCH"
  | "CHECKPOINT_SCHEMA_MISMATCH"
  | "CHECKPOINT_CONFLICT"
  | "CANCELLED"
  | "STEP_FAILED";

export interface DurableErrorDetails {
  code: DurableErrorCode;
  message: string;
  runId: string | null;
  checkpointSeq: number | null;
  artifactId: string | null;
}

export interface DurableRunResult {
  runId: string;
  status: DurableStatus;
  checkpoint: DurableCheckpoint;
  error: DurableErrorDetails | null;
}

export interface DurableAttempt {
  attemptId: string;
  previousAttemptId: string | null;
  generation: number;
  /** The checkpoint that scheduled this attempt. */
  checkpointSeq: number;
  committedCheckpointSeq: number | null;
  work: DurableWork;
  status: "started" | "interrupted" | "cancelled" | "failed" | "committed";
}

export interface DurableExecutionStore {
  readonly leaseMs: number;
  createRun(checkpoint: DurableCheckpoint): Promise<boolean>;
  readRun(runId: string): Promise<DurableRunResult | null>;
  readCheckpoint(runId: string, checkpointSeq: number): Promise<DurableCheckpoint | null>;
  /** Returns committed checkpoints in any order. */
  listCheckpoints(runId: string): Promise<readonly DurableCheckpoint[]>;
  listAttempts(runId: string): Promise<readonly DurableAttempt[]>;
  /** Atomically checks the head sequence and claims an unowned or expired run. */
  acquire(runId: string, expectedSeq: number, owner: string): Promise<boolean>;
  renew(runId: string, owner: string): Promise<boolean>;
  release(runId: string, owner: string): Promise<void>;
  /** Records the attempt before work starts. Links the latest attempt for this generation and operation. */
  beginAttempt(runId: string, owner: string, attempt: DurableAttempt): Promise<DurableAttempt | null>;
  /** Atomically publishes the next checkpoint, marks its attempt committed and updates the run. */
  commit(checkpoint: DurableCheckpoint, owner: string): Promise<boolean>;
  stop(runId: string, owner: string, status: "cancelled" | "failed", error: DurableErrorDetails): Promise<boolean>;
  /** Stores immutable bytes before a ref may be published by a checkpoint. */
  putArtifact(kind: string, bytes: Uint8Array): Promise<DurableArtifactRef>;
  readArtifact(id: string): Promise<Uint8Array | null>;
}

export interface DurableStepContext {
  runId: string;
  checkpoint: DurableCheckpoint;
  work: DurableWork;
  attemptId: string;
  previousAttemptId: string | null;
  signal: AbortSignal;
  /** Returns the latest matching committed work in the current generation. */
  findReusableWork(): { checkpointSeq: number; committed: DurableCommittedWork } | null;
  /** Resolves an input, retained or committed artifact ID in the current generation. */
  getArtifactRef(id: string): DurableArtifactRef | null;
  putArtifact(kind: string, bytes: Uint8Array): Promise<DurableArtifactRef>;
  readArtifact(ref: DurableArtifactRef): Promise<Uint8Array>;
}

export type DurableStep = (context: DurableStepContext) => DurableStepResult | Promise<DurableStepResult>;

export interface DurableWorkflow {
  workflowKey: string;
  revision: string;
  steps: Readonly<Record<string, DurableStep>>;
}

export interface DurableRunOptions {
  input: SnapshotInput;
  first: DurableWork;
  store: DurableExecutionStore;
  /** Supply an ID to look up a run even if its creating process is killed. */
  runId?: string;
  signal?: AbortSignal;
  /** Maximum committed work units for this invocation. The pending unit stays in the checkpoint. */
  maxSteps?: number;
}

export interface DurableResumeOptions {
  workflow: DurableWorkflow;
  expectedInput: SnapshotInput;
  expectedCheckpointSeq?: number;
  store: DurableExecutionStore;
  signal?: AbortSignal;
  maxSteps?: number;
}

export interface DurableInputChangeOptions {
  workflow: DurableWorkflow;
  expectedCheckpointSeq: number;
  input: SnapshotInput;
  affectedScope: DurableJSON;
  reuseArtifactIds: readonly string[];
  next: DurableWork;
  store: DurableExecutionStore;
}

export interface DurableRerunOptions {
  workflow: DurableWorkflow;
  rerun: DurableRerun;
  next: DurableWork;
  store: DurableExecutionStore;
  signal?: AbortSignal;
}
