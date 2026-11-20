import type { PipelineSchema } from "../pipeline-schema.js";
import type { PipelineOperationDescriptor } from "../pipeline-planner.js";
import type { DurableCheckpoint, DurableExecutionStore, DurableJSON, DurableRerun, DurableRunResult } from "./durable.js";
import type { McpWorkflowContext, McpWorkflowFactory, McpWorkflowPlan, McpWorkflowProfile, McpWorkflowProgressUpdate } from "./mcp.js";

export interface PipelineDescriptor {
  description: string;
  revision: string;
  inputSchema: PipelineSchema;
  outputSchema: PipelineSchema;
  stageOrder?: readonly string[];
  operations?: readonly PipelineOperationDescriptor[];
}

export interface PipelineStepContext {
  /** The original input pinned to this run. */
  request: DurableJSON;
  /** Latest output of each step on the path leading to this attempt. */
  outputs: Readonly<Record<string, DurableJSON>>;
  stepKey: string;
  runId: string;
  workDirectory: string;
  operationKey: string;
  attemptId: string;
  signal: AbortSignal;
  rerun: DurableRerun | null;
  reportProgress(update: Omit<McpWorkflowProgressUpdate, "attemptId" | "stepKey">): void;
}

export interface PipelineStep {
  key: string;
  description?: string;
  /** Per-step rules, including versions of external dependencies, pinned to the run. */
  rules?: DurableJSON;
  inputSchema: PipelineSchema;
  outputSchema: PipelineSchema;
  selectInput?(previous: DurableJSON, context: PipelineStepContext): DurableJSON;
  run(input: DurableJSON, context: PipelineStepContext): DurableJSON | Promise<DurableJSON>;
  /** Omit for the next step in declaration order. Return null to finish. */
  next?: string | null | ((output: DurableJSON, context: PipelineStepContext) => string | null);
  /** Stop after committing this step. The next invocation continues from that boundary. */
  pauseAfter?: boolean;
  /** A read-only readiness check. False releases the invocation without starting a step attempt. */
  waitUntil?(context: PipelineWaitContext): boolean | Promise<boolean>;
}

export type PipelineWaitContext = Omit<PipelineStepContext, "attemptId" | "reportProgress"> & { checkpoint: DurableCheckpoint };

export interface PipelineOptions extends Omit<PipelineDescriptor, "stageOrder" | "operations"> {
  key: string;
  /** Additional JSON rules or a validated plan to pin alongside the request. */
  rules?: DurableJSON;
  /** Maximum number of edges traversed on one execution path. Defaults to 256. */
  maxTransitions?: number;
  steps: readonly PipelineStep[];
}

export type PipelineHostContext = Omit<McpWorkflowContext, "request"> & { request: DurableJSON };

export interface PipelineDefinition {
  readonly key: string;
  /** SHA-256 of this definition's schemas, routes, rules and revision. */
  readonly fingerprint: string;
  readonly descriptor: PipelineDescriptor & { stageOrder: readonly string[] };
  createWorkflow(context: PipelineHostContext): Promise<McpWorkflowPlan>;
}

export interface PipelineRunOptions {
  store?: DurableExecutionStore;
  /** Defaults to out/pipelines under the current directory. */
  stateDirectory?: string;
  runId?: string;
  resume?: boolean;
  /** Optimistic concurrency check for resume. Required inside a rerun request. */
  expectedCheckpointSeq?: number;
  rerun?: DurableRerun;
  signal?: AbortSignal;
  maxSteps?: number;
  profile?: McpWorkflowProfile;
  reportProgress?(update: McpWorkflowProgressUpdate): void;
}

export type PipelineRunResult = DurableRunResult & { output?: DurableJSON };
export type PipelineFactory = McpWorkflowFactory & { descriptor?: PipelineDescriptor };
