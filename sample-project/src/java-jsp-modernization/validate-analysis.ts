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
import type { AnalysisResult, ValidationResult } from "./types.js";

export class ValidateAnalysisTask extends Task {
  name = "validateAnalysis";
  memoryPhase = "REFLECTION" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireInput(ctx.input);
    const snapshot = await readWorkflowJson<LeflectWorkspaceSnapshot>(
      ctx,
      "leflect-snapshot",
      "raw",
    );
    const analysis = await readWorkflowJson<AnalysisResult>(ctx, "analysis");
    const validationPath = resolve(input.outputDir, "02-validation.json");

    if (input.forceValidationFail) {
      const forced: ValidationResult = {
        approved: false,
        confidence: 0,
        preservedContracts: [],
        missingCoverage: ["Forced failure path for validation stage."],
        warnings: ["Use this mode to verify fail rendering and recovery artifact output."],
        blockingIssues: ["Forced validation failure requested by SAMPLE_FORCE_VALIDATION_FAIL."],
      };

      await writeOutputArtifact(
        ctx,
        validationPath,
        "02-validation.json",
        "application/json",
        `${JSON.stringify(forced, null, 2)}\n`,
        { task: this.name, forced: true },
      );
      await writeWorkflowRecord(
        ctx,
        "validation",
        "Forced validation failure for sample-project Java/JSP modernization example",
        forced,
      );

      ctx.log.warn("Forced validation failure requested", {
        validationPath,
      });

      return {
        status: "fail",
        error: {
          message:
            forced.blockingIssues[0] ??
            "Forced validation failure requested by SAMPLE_FORCE_VALIDATION_FAIL.",
          code: "FORCED_VALIDATION_FAILURE",
          details: forced,
        },
      };
    }

    try {
      const response = await ctx.ai.chat(
        withOptionalHttp(input, {
          temperature: 0.1,
          messages: [
            {
              role: "developer",
              content:
                "당신은 Java/JSP 현대화 분석 검증 담당자다. Leflect snapshot 과 분석 결과를 비교해 누락과 보존 규칙을 점검한다. JSON 만 반환하고 키는 approved, confidence, preservedContracts, missingCoverage, warnings, blockingIssues 로 고정한다.",
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
                "Automatic memory context:",
                summarizeText(ctx.memoryContext?.assembledContext ?? "none", 500),
              ].join("\n"),
            },
          ],
        }),
      );

      const validation = await parseStructuredJson<ValidationResult>(
        ctx,
        input,
        response.outputText,
        "validation",
        "approved:boolean, confidence:number, preservedContracts:string[], missingCoverage:string[], warnings:string[], blockingIssues:string[]",
      );

      await writeOutputArtifact(
        ctx,
        validationPath,
        "02-validation.json",
        "application/json",
        `${JSON.stringify(validation, null, 2)}\n`,
        { task: this.name },
      );
      await writeWorkflowRecord(
        ctx,
        "validation",
        "Validation result for sample-project Java/JSP modernization example",
        validation,
      );

      if (!validation.approved) {
        ctx.log.warn("Validation rejected the modernization analysis", {
          blockingIssueCount: validation.blockingIssues.length,
        });
        return {
          status: "fail",
          error: {
            message:
              validation.blockingIssues[0] ?? "Validation rejected the modernization analysis.",
            code: "VALIDATION_REJECTED",
            details: validation,
          },
        };
      }

      ctx.log.success("Validation approved the analysis", {
        confidence: validation.confidence,
        preservedContractCount: validation.preservedContracts.length,
      });

      return {
        status: "success",
        output: {
          validationPath,
        },
      };
    } catch (error) {
      ctx.log.error("Validation stage failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return toTaskFailure(this.name, error);
    }
  }
}
