import { Task, type TaskResult, type WorkflowContext } from "agentic-task-kit";
import { resolve } from "node:path";
import { type LeflectWorkspaceSnapshot } from "../leflect-snapshot.js";
import { resolveOutputPath } from "../sample-files.js";
import {
  parseStructuredJson,
  readWorkflowJson,
  requireInput,
  runStreamingChat,
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
  ReimplementationResult,
  RequirementsResult,
  ValidationResult,
} from "./types.js";

export class ReimplementAssetsTask extends Task {
  name = "reimplementAssets";
  memoryPhase = "EXECUTION" as const;
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
    const design = await readWorkflowJson<DesignResult>(ctx, "design");
    const reimplementationContext = await ctx.memory.retrieve({
      query:
        "reimplement java jsp preserve request attributes status literals compatibility requirements",
      taskType: this.memoryTaskType,
      phase: this.memoryPhase,
    });

    try {
      const outputText = await runStreamingChat(
        ctx,
        withOptionalHttp(input, {
          temperature: 0.1,
          messages: [
            {
              role: "developer",
              content:
                "당신은 Java/JSP 재구현 담당자다. raw source 전문이 아니라 Leflect snapshot, 분석, 검증, 요구사항, 설계만 근거로 결과를 만든다. JSON 만 반환하고 키는 javaFiles, jspFiles, migrationNotes 로 고정한다. javaFiles 와 jspFiles 는 각각 { path, content } 배열이다. 보존 규칙과 request attribute 이름, status literal, externally visible contract 를 유지해야 한다.",
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
                "Design:",
                JSON.stringify(design, null, 2),
                "",
                "Automatic memory context:",
                summarizeText(ctx.memoryContext?.assembledContext ?? "none", 500),
                "",
                "Manual retrieval context:",
                summarizeText(reimplementationContext.assembledContext || "none", 500),
              ].join("\n"),
            },
          ],
        }),
      );

      const reimplementation = await parseStructuredJson<ReimplementationResult>(
        ctx,
        input,
        outputText,
        "reimplementation",
        "javaFiles:{path:string,content:string}[], jspFiles:{path:string,content:string}[], migrationNotes:string[]",
      );
      const manifestPath = resolve(input.outputDir, "05-reimplementation.json");
      const reimplementationRoot = resolve(input.outputDir, "06-reimplementation");

      for (const javaFile of reimplementation.javaFiles) {
        await writeOutputArtifact(
          ctx,
          resolveOutputPath(reimplementationRoot, javaFile.path),
          javaFile.path,
          "text/x-java-source",
          `${javaFile.content.trim()}\n`,
          {
            task: this.name,
            kind: "java",
          },
        );
      }

      for (const jspFile of reimplementation.jspFiles) {
        await writeOutputArtifact(
          ctx,
          resolveOutputPath(reimplementationRoot, jspFile.path),
          jspFile.path,
          "text/x-jsp",
          `${jspFile.content.trim()}\n`,
          {
            task: this.name,
            kind: "jsp",
          },
        );
      }

      await writeOutputArtifact(
        ctx,
        manifestPath,
        "05-reimplementation.json",
        "application/json",
        `${JSON.stringify(reimplementation, null, 2)}\n`,
        { task: this.name },
      );
      await writeWorkflowRecord(
        ctx,
        "reimplementation",
        "Reimplementation manifest for sample-project Java/JSP modernization example",
        reimplementation,
      );

      ctx.log.success("Generated Java/JSP reimplementation", {
        manifestPath,
        javaFileCount: reimplementation.javaFiles.length,
        jspFileCount: reimplementation.jspFiles.length,
      });

      return {
        status: "success",
        output: {
          manifestPath,
          reimplementationRoot,
        },
      };
    } catch (error) {
      ctx.log.error("Reimplementation stage failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return toTaskFailure(this.name, error);
    }
  }
}
