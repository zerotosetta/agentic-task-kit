import { Task, type TaskResult, type WorkflowContext } from "agentic-task-kit";
import { resolve } from "node:path";
import { buildLeflectWorkspaceSnapshot } from "../leflect-snapshot.js";
import {
  parseStructuredJson,
  requireInput,
  runStreamingChat,
  snapshotForPrompt,
  summarizeText,
  toTaskFailure,
  withOptionalHttp,
  writeOutputArtifact,
  writeWorkflowRecord,
} from "./helpers.js";
import type { AnalysisResult } from "./types.js";

export class AnalyzeAssetsTask extends Task {
  name = "analyzeAssets";
  memoryPhase = "PLANNING" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireInput(ctx.input);
    const snapshot = await buildLeflectWorkspaceSnapshot(input.workspaceRoot);
    const manualContext = await ctx.memory.retrieve({
      query: "java jsp modernization preserve public contract request attribute status literals",
      taskType: this.memoryTaskType,
      phase: this.memoryPhase,
    });
    const snapshotPath = resolve(input.outputDir, "00-leflect-snapshot.json");

    await writeOutputArtifact(
      ctx,
      snapshotPath,
      "00-leflect-snapshot.json",
      "application/json",
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { task: this.name },
    );
    await writeWorkflowRecord(
      ctx,
      "leflect-snapshot",
      "Structured Leflect snapshot for sample-project Java/JSP modernization example",
      snapshot,
      "raw",
    );

    try {
      const outputText = await runStreamingChat(
        ctx,
        withOptionalHttp(input, {
          temperature: 0.2,
          messages: [
            {
              role: "developer",
              content:
                "당신은 Java/JSP 레거시 현대화 분석가다. raw source 전문을 재구성하지 말고 제공된 Leflect structured snapshot 만 근거로 판단한다. JSON 만 반환하고 키는 overview, javaContracts, jspContracts, crossLayerContracts, preservationRules, modernizationTargets, risks 로 고정한다.",
            },
            {
              role: "user",
              content: [
                "Leflect snapshot:",
                snapshotForPrompt(snapshot),
                "",
                "Automatic memory context:",
                summarizeText(ctx.memoryContext?.assembledContext ?? "none", 500),
                "",
                "Manual retrieval context:",
                summarizeText(manualContext.assembledContext || "none", 500),
              ].join("\n"),
            },
          ],
        }),
      );

      const analysis = await parseStructuredJson<AnalysisResult>(
        ctx,
        input,
        outputText,
        "analysis",
        "overview:string, javaContracts:string[], jspContracts:string[], crossLayerContracts:string[], preservationRules:string[], modernizationTargets:string[], risks:string[]",
      );
      const analysisPath = resolve(input.outputDir, "01-analysis.json");

      await writeOutputArtifact(
        ctx,
        analysisPath,
        "01-analysis.json",
        "application/json",
        `${JSON.stringify(analysis, null, 2)}\n`,
        { task: this.name },
      );
      await writeWorkflowRecord(
        ctx,
        "analysis",
        "Analysis result for sample-project Java/JSP modernization example",
        analysis,
      );

      ctx.log.success("Completed Java/JSP analysis stage", {
        workspaceRoot: input.workspaceRoot,
        javaFileCount: snapshot.javaFiles.length,
        jspFileCount: snapshot.jspFiles.length,
      });

      return {
        status: "success",
        output: {
          snapshotPath,
          analysisPath,
        },
      };
    } catch (error) {
      ctx.log.error("Java/JSP analysis stage failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return toTaskFailure(this.name, error);
    }
  }
}
