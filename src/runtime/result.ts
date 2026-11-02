import type {
  CycleRunResult,
  ExecutionFrame,
  ExecutionHistoryTracker,
  LifecycleReport,
  RunArtifact,
  WorkflowContext,
} from "../types.js";

export const EMPTY_LIFECYCLE_REPORT: LifecycleReport = {
  archivedIds: [],
  deletedIds: [],
  compressedIds: [],
  expiredIds: [],
};

function isRunScopedRecord(
  record: { workflowId?: string; runId?: string },
  workflowId: string,
  runId: string,
): boolean {
  return record.runId === runId || record.workflowId === workflowId;
}

function sortRecordsByTimestamp(left: { createdAt: number }, right: { createdAt: number }): number {
  return left.createdAt - right.createdAt;
}

export async function collectRunResultSnapshot(args: {
  frame: ExecutionFrame;
  memory: WorkflowContext["memory"];
  artifacts: RunArtifact[];
  lifecycle: LifecycleReport;
  history: ExecutionHistoryTracker;
}): Promise<CycleRunResult> {
  const runScopedFilter = {
    workflowId: args.frame.workflowId,
    runId: args.frame.runId,
  } as const;
  const activeRecords = (await args.memory.list({ ...runScopedFilter, archived: false }))
    .filter((record) => isRunScopedRecord(record, args.frame.workflowId, args.frame.runId))
    .sort(sortRecordsByTimestamp);
  const archivedRecords = (await args.memory.list({ ...runScopedFilter, archived: true }))
    .filter((record) => isRunScopedRecord(record, args.frame.workflowId, args.frame.runId))
    .sort(sortRecordsByTimestamp);
  const stats = await args.memory.getStats(runScopedFilter);

  return {
    frame: args.frame,
    memory: {
      records: [...activeRecords, ...archivedRecords],
      activeRecords,
      archivedRecords,
      lifecycle: args.lifecycle,
      stats,
    },
    artifacts: {
      artifacts: args.artifacts.map((artifact) => ({
        ...artifact,
        bytes: new Uint8Array(artifact.bytes),
      })),
    },
    history: args.history.snapshot(),
    flushMemory: async () =>
      args.memory.flush({
        workflowId: args.frame.workflowId,
        runId: args.frame.runId,
      }),
  };
}
