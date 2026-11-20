import type {
  DurableCheckpoint,
  DurableExecutionStore,
  DurableJSON,
  DurableOutcome,
  DurableRerun,
  DurableWork,
  DurableWorkflow,
  SnapshotInput,
} from "./durable.js";
import type { NormalizedFailure } from "../durable-errors.js";

export interface McpWorkflowProfile {
  name: string;
  module: string;
  revision: string;
  settings: DurableJSON;
  maxSteps?: number;
  /** Ordered durable step keys used to display stage positions for new runs. */
  stageOrder?: readonly string[];
}

export interface McpWorkflowContext {
  runId: string;
  workDirectory: string;
  profile: McpWorkflowProfile;
  request: Readonly<Record<string, DurableJSON>>;
  store: DurableExecutionStore;
  checkpoint: DurableCheckpoint | null;
  signal: AbortSignal;
  /** Publish a bounded snapshot from the executing durable step handler. */
  reportProgress(update: McpWorkflowProgressUpdate): void;
}

export interface McpWorkflowProgressUpdate {
  /** Capture the durable step context's attemptId when registering an asynchronous callback. */
  attemptId: string;
  stepKey: string;
  operation?: string;
  completed?: number;
  total?: number;
  unit?: string;
  item?: string;
  message?: string;
}

export interface McpWorkflowProgress extends McpWorkflowProgressUpdate {
  sequence: number;
  updatedAt: string;
  generation: number;
  /** Checkpoint that scheduled the reporting attempt. */
  checkpointSeq: number;
}

export interface McpWorkflowInputChange {
  input: SnapshotInput;
  affectedScope: DurableJSON;
  reuseArtifactIds: readonly string[];
  next: DurableWork;
}

export interface McpWorkflowPlan {
  workflow: DurableWorkflow;
  input: SnapshotInput;
  first: DurableWork;
  /** Release the invocation at a committed boundary while retaining its pending work. */
  pauseBefore?(context: { checkpoint: DurableCheckpoint; signal: AbortSignal }): boolean | Promise<boolean>;
  prepareNext?(context: { checkpoint: DurableCheckpoint; signal: AbortSignal }):
    McpWorkflowInputChange | undefined | null | Promise<McpWorkflowInputChange | undefined | null>;
  /** Validate and plan a caller-selected stage using previously committed run data. */
  planRerun?(context: { checkpoint: DurableCheckpoint; request: McpWorkflowRerunRequest; signal: AbortSignal }):
    DurableWork | Promise<DurableWork>;
}

export type McpWorkflowRerunRequest = DurableRerun;

export type McpWorkflowFactory = (context: McpWorkflowContext) => McpWorkflowPlan | Promise<McpWorkflowPlan>;

export interface McpWorkflowStatus {
  runId: string;
  profile: string;
  status: "queued" | "running" | "interrupted" | "cancelled" | "failed" | "completed";
  checkpointSeq: number | null;
  generation: number | null;
  currentStep: string | null;
  lastCompletedStep: { stepKey: string; checkpointSeq: number; generation: number; outcome: DurableOutcome } | null;
  progress: McpWorkflowProgress | null;
  lastProgressAt: string | null;
  worker: {
    state: "starting" | "alive" | "expired" | "stopped";
    pid: number | null;
    startedAt: string | null;
    heartbeatAt: string | null;
    leaseExpiresAt: string | null;
  };
  nextAction: {
    action: "status" | "resume" | "results" | "inspect";
    tool: "workflow_status" | "workflow_resume" | "workflow_results" | null;
    arguments: Readonly<Record<string, DurableJSON>>;
    reason: string;
    retryAfterMs?: number;
  };
  domainStatus: string | null;
  outcome: DurableOutcome | null;
  inputSha256: string | null;
  error: NormalizedFailure | null;
  cancelRequested: boolean;
  rerun?: DurableRerun;
  pendingRerun?: DurableRerun;
}

export interface McpWorkflowProgressView extends Pick<McpWorkflowStatus,
  "runId" | "status" | "lastCompletedStep" | "lastProgressAt" | "worker" | "error" | "cancelRequested"> {
  nextAction: Omit<McpWorkflowStatus["nextAction"], "tool"> & {
    tool: "workflow_progress" | "workflow_resume" | "workflow_results" | null;
  };
  stage: {
    phase: "queued" | "preparing" | "executing" | "finalizing" | "interrupted" | "cancelled" | "failed" | "completed";
    stepKey: string | null;
    /** One-based position in the profile's declared order. */
    position: number | null;
    total: number | null;
  };
  /** Most recent applicable report, with a percentage of this operation when counts are available. */
  detail: (McpWorkflowProgress & { percent: number | null }) | null;
}
