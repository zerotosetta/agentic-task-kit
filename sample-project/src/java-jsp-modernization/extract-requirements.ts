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
import type { AnalysisResult, RequirementsResult, ValidationResult } from "./types.js";

export class ExtractRequirementsTask extends Task {
  name = "extractRequirements";
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
    const requirementsContext = await ctx.memory.retrieve({
      query:
        "java jsp modernization requirements preserve contracts compatibility acceptance criteria",
      taskType: this.memoryTaskType,
      phase: this.memoryPhase,
    });

    try {
      const response = await ctx.ai.chat(
        withOptionalHttp(input, {
          temperature: 0.1,
          messages: [
            {
              role: "developer",
              content:
                "당신은 Java/JSP 현대화 요구사항 분석가다. Leflect snapshot, 분석 결과, 검증 결과를 기반으로 재구현 요구사항을 정리한다. JSON 만 반환하고 키는 functionalRequirements, compatibilityRequirements, javaRequirements, jspRequirements, acceptanceCriteria, unresolvedQuestions 로 고정한다.",
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
                "Automatic memory context:",
                summarizeText(ctx.memoryContext?.assembledContext ?? "none", 500),
                "",
                "Manual retrieval context:",
                summarizeText(requirementsContext.assembledContext || "none", 500),
              ].join("\n"),
            },
          ],
        }),
      );

      const requirements = await parseStructuredJson<RequirementsResult>(
        ctx,
        input,
        response.outputText,
        "requirements",
        "functionalRequirements:string[], compatibilityRequirements:string[], javaRequirements:string[], jspRequirements:string[], acceptanceCriteria:string[], unresolvedQuestions:string[]",
      );
      const requirementsPath = resolve(input.outputDir, "03-requirements.json");

      await writeOutputArtifact(
        ctx,
        requirementsPath,
        "03-requirements.json",
        "application/json",
        `${JSON.stringify(requirements, null, 2)}\n`,
        { task: this.name },
      );
      await writeWorkflowRecord(
        ctx,
        "requirements",
        "Requirements result for sample-project Java/JSP modernization example",
        requirements,
      );

      ctx.log.success("Extracted modernization requirements", {
        functionalRequirementCount: requirements.functionalRequirements.length,
        compatibilityRequirementCount: requirements.compatibilityRequirements.length,
      });

      return {
        status: "success",
        output: {
          requirementsPath,
        },
      };
    } catch (error) {
      ctx.log.error("Requirements extraction stage failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return toTaskFailure(this.name, error);
    }
  }
}
