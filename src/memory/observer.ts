import { ExecutionBroadcaster } from "../events.js";
import type { ExecutionEvent, MemoryEngine } from "../types.js";

type MemoryEventType =
  | "memory.before_step"
  | "memory.after_step"
  | "memory.write"
  | "memory.warning"
  | "memory.merge"
  | "memory.compress"
  | "memory.expire"
  | "memory.archive"
  | "retrieval.performed";

type ObservedMemoryEngineArgs = {
  engine: MemoryEngine;
  broadcaster: ExecutionBroadcaster;
  workflowId: string;
  runId: string;
  now: () => number;
};

export function createObservedMemoryEngine(args: ObservedMemoryEngineArgs): MemoryEngine {
  const emit = async (
    type: MemoryEventType,
    summary: string,
    meta?: Record<string, unknown>,
  ): Promise<void> => {
    const event: ExecutionEvent = {
      type,
      timestamp: args.now(),
      workflowId: args.workflowId,
      runId: args.runId,
      summary,
      ...(meta ? { meta } : {}),
    };
    await args.broadcaster.emit(event);
  };

  return {
    async beforeStep(input) {
      const context = await args.engine.beforeStep(input);
      await emit("memory.before_step", `beforeStep ${input.taskName}`, {
        taskName: input.taskName,
        taskType: input.taskType,
        phase: input.phase,
        routedShards: context.routedShards,
        usedTokens: context.usedTokens,
      });
      return context;
    },
    async afterStep(input) {
      const report = await args.engine.afterStep(input);
      await emit("memory.after_step", `afterStep ${input.taskName}`, {
        taskName: input.taskName,
        taskRecordAction: report.taskRecord.action,
        workflowRecordAction: report.workflowRecord.action,
        compressedIds: report.compressedIds,
      });
      return report;
    },
    async write(record) {
      const disposition = await args.engine.write(record);
      const eventType =
        disposition.action === "merge"
          ? "memory.merge"
          : disposition.action === "compress"
            ? "memory.compress"
            : "memory.write";
      await emit(eventType, `${disposition.action} ${record.shard}/${record.kind}`, {
        recordId: disposition.recordId,
        targetId: disposition.targetId,
        reason: disposition.reason,
        importance: disposition.importance,
        similarityScore: disposition.similarityScore,
      });
      if (disposition.warningCode) {
        await emit("memory.warning", `${disposition.warningCode} ${disposition.reason}`, {
          code: disposition.warningCode,
          action: disposition.action,
          recordId: disposition.recordId,
          targetId: disposition.targetId,
          reason: disposition.reason,
          importance: disposition.importance,
          similarityScore: disposition.similarityScore,
        });
      }
      return disposition;
    },
    async get(id) {
      return args.engine.get(id);
    },
    async retrieve(request) {
      const result = await args.engine.retrieve({ ...request, scope: request.scope ?? { workflowId: args.workflowId, runId: args.runId, includeGlobal: true } });
      await emit("retrieval.performed", `retrieve ${request.taskType}`, {
        query: request.query,
        routedShards: result.routedShards,
        hitCount: result.hits.length,
        usedTokens: result.usedTokens,
      });
      return result;
    },
    async getStats(filter) {
      return args.engine.getStats(filter);
    },
    async flush(filter) {
      return args.engine.flush(filter);
    },
    async runLifecycle(now) {
      const report = await args.engine.runLifecycle(now);
      if (report.compressedIds.length > 0) {
        await emit("memory.compress", "lifecycle compress", {
          compressedIds: report.compressedIds,
        });
      }
      if (report.archivedIds.length > 0) {
        await emit("memory.archive", "lifecycle archive", {
          archivedIds: report.archivedIds,
        });
        await emit(
          "memory.warning",
          `lifecycle archive ${report.archivedIds.length} record(s) archived`,
          {
            code: "lifecycle_archive",
            archivedIds: report.archivedIds,
            reason: `${report.archivedIds.length} record(s) archived by lifecycle`,
          },
        );
      }
      if (report.expiredIds.length > 0 || report.deletedIds.length > 0) {
        await emit("memory.expire", "lifecycle expire", {
          expiredIds: report.expiredIds,
          deletedIds: report.deletedIds,
        });
        if (report.deletedIds.length > 0) {
          await emit(
            "memory.warning",
            `lifecycle delete ${report.deletedIds.length} record(s) deleted`,
            {
              code: "lifecycle_delete",
              deletedIds: report.deletedIds,
              expiredIds: report.expiredIds,
              reason: `${report.deletedIds.length} record(s) deleted by lifecycle`,
            },
          );
        }
      }
      return report;
    },
    async list(query) {
      return args.engine.list(query);
    },
  };
}
