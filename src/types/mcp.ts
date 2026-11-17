import type {
  DurableCheckpoint,
  DurableExecutionStore,
  DurableJSON,
  DurableOutcome,
  DurableWork,
  DurableWorkflow,
  SnapshotInput,
} from "./durable.js";

export interface McpWorkflowProfile {
  name: string;
  module: string;
  revision: string;
  settings: DurableJSON;
  maxSteps?: number;
}

export interface McpWorkflowContext {
  runId: string;
  workDirectory: string;
  profile: McpWorkflowProfile;
  request: Readonly<Record<string, DurableJSON>>;
  store: DurableExecutionStore;
  checkpoint: DurableCheckpoint | null;
  signal: AbortSignal;
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
  prepareNext?(context: { checkpoint: DurableCheckpoint; signal: AbortSignal }):
    McpWorkflowInputChange | undefined | null | Promise<McpWorkflowInputChange | undefined | null>;
}

export type McpWorkflowFactory = (context: McpWorkflowContext) => McpWorkflowPlan | Promise<McpWorkflowPlan>;

export interface McpWorkflowStatus {
  runId: string;
  profile: string;
  status: "queued" | "running" | "interrupted" | "cancelled" | "failed" | "completed";
  checkpointSeq: number | null;
  generation: number | null;
  currentStep: string | null;
  domainStatus: string | null;
  outcome: DurableOutcome | null;
  inputSha256: string | null;
  error: { code: string; message: string } | null;
  cancelRequested: boolean;
}
