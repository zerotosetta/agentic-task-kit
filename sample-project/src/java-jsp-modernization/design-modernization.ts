import { Task, type TaskResult, type WorkflowContext } from "agentic-task-kit";
import { resolve } from "node:path";
import { type LeflectWorkspaceSnapshot } from "../leflect-snapshot.js";
import {
  parseStructuredJson,
  readWorkflowJson,
  requireInput,
  snapshotForPrompt,
  summarizeText,
  toTaskFailure,
  withOptionalHttp,
  writeOutputArtifact,
  writeWorkflowRecord,
} from "./helpers.js";
import type {
  AnalysisResult,
  DesignResult,
  RequirementsResult,
  ValidationResult,
} from "./types.js";

export class DesignModernizationTask extends Task {
  name = "designModernization";
  memoryPhase = "PLANNING" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireInput(ctx.input);
    const snapshot = await readWorkflowJson<LeflectWorkspaceSnapshot>(
      ctx,
      "leflect-snapshot",
      "raw",
    );
    const analysis = await readWorkflowJson<AnalysisResult>(ctx, "analysis");
    const validation = await readWorkflowJson<ValidationResult>(ctx, "validation");
    const requirements = await readWorkflowJson<RequirementsResult>(ctx, "requirements");
    const designContext = await ctx.memory.retrieve({
      query:
        "java controller jsp view modernization design compatibility request attributes status literals",
      taskType: this.memoryTaskType,
      phase: this.memoryPhase,
    });

    try {
      const response = await ctx.ai.chat(
        withOptionalHttp(input, {
          temperature: 0.15,
          messages: [
            {
              role: "developer",
              content:
                "당신은 Java/JSP 현대화 설계자다. Leflect snapshot, 분석 결과, 검증 결과, 요구사항을 바탕으로 재구현 설계를 만든다. JSON 만 반환하고 키는 architectureSummary, javaDesignDecisions, jspDesignDecisions, compatibilityNotes, migrationSequence, testStrategy 로 고정한다.",
            },
            {
              role: "user",
              content: [
                "Snapshot:",
                snapshotForPrompt(snapshot),
                "",
                "Analysis:",
                JSON.stringify(analysis, null, 2),
                "",
                "Validation:",
                JSON.stringify(validation, null, 2),
                "",
                "Requirements:",
                JSON.stringify(requirements, null, 2),
                "",
                "Manual retrieval context:",
                summarizeText(designContext.assembledContext || "none", 500),
              ].join("\n"),
            },
          ],
        }),
      );

      const design = await parseStructuredJson<DesignResult>(
        ctx,
        input,
        response.outputText,
        "design",
        "architectureSummary:string, javaDesignDecisions:string[], jspDesignDecisions:string[], compatibilityNotes:string[], migrationSequence:string[], testStrategy:string[]",
      );
      const designPath = resolve(input.outputDir, "04-design.json");

      await writeOutputArtifact(
        ctx,
        designPath,
        "04-design.json",
        "application/json",
        `${JSON.stringify(design, null, 2)}\n`,
        { task: this.name },
      );
      await writeWorkflowRecord(
        ctx,
        "design",
        "Design result for sample-project Java/JSP modernization example",
        design,
      );

      ctx.log.success("Produced modernization design", {
        designPath,
        migrationSteps: design.migrationSequence.length,
      });

      return {
        status: "success",
        output: {
          designPath,
        },
      };
    } catch (error) {
      ctx.log.error("Design stage failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return toTaskFailure(this.name, error);
    }
  }
}
