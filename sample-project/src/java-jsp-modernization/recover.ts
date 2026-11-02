import { Task, type TaskResult, type WorkflowContext } from "agentic-task-kit";
import { resolve } from "node:path";
import { requireInput, writeOutputArtifact, writeWorkflowRecord } from "./helpers.js";

export class RecoverTask extends Task {
  name = "recover";
  memoryPhase = "RECOVERY" as const;
  memoryTaskType = "debug" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireInput(ctx.input);
    const lifecycle = await ctx.memory.runLifecycle(ctx.now());
    const recoveryContext = await ctx.memory.retrieve({
      query:
        "java jsp recovery remediation preserve contract validation requirements design blockers",
      taskType: this.memoryTaskType,
      phase: this.memoryPhase,
    });
    const recoveryPath = resolve(input.outputDir, "09-recovery.md");

    const note = [
      "# Recovery Guidance",
      "",
      "Java/JSP 현대화 워크플로우가 실패 경로로 종료되었습니다.",
      "",
      "## Last Error",
      ctx.memoryContext?.assembledContext || "No automatic context available.",
      "",
      "## Debug Retrieval Context",
      recoveryContext.assembledContext || "none",
      "",
      "## Next Actions",
      "- Leflect snapshot 에서 누락된 contract 와 unresolved diagnostic 을 먼저 확인한다.",
      "- validation blocking issue 와 requirements omission 을 해소한 뒤 다시 실행한다.",
      "- request attribute 이름, status literal, public method 시그니처 보존 규칙을 재검토한다.",
      "",
      "## Lifecycle Report",
      `- archivedIds: ${lifecycle.archivedIds.join(", ") || "-"}`,
      `- deletedIds: ${lifecycle.deletedIds.join(", ") || "-"}`,
      `- compressedIds: ${lifecycle.compressedIds.join(", ") || "-"}`,
    ].join("\n");

    await writeOutputArtifact(ctx, recoveryPath, "09-recovery.md", "text/markdown", `${note}\n`, {
      task: this.name,
    });
    await writeWorkflowRecord(
      ctx,
      "recovery",
      "Recovery note for sample-project Java/JSP modernization example",
      note,
    );

    ctx.log.warn("Recovery artifact created", {
      recoveryPath,
      archivedIds: lifecycle.archivedIds,
    });

    return {
      status: "success",
      output: {
        recoveryPath,
      },
    };
  }
}
