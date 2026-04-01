import { Task } from "../task.js";
import type {
  TaskResult,
  WorkflowDefinition,
  WorkflowContext,
  WorkflowMemory
} from "../types.js";
import {
  getWorkflowInputValue,
  workflowInputToPrettyJson
} from "../workflow-input.js";

function summarizeText(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }

  return `${trimmed.slice(0, 117)}...`;
}

class AnalyzeTask extends Task {
  name = "analyze";
  memoryPhase = "PLANNING" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const sourceText =
      getWorkflowInputValue<string>(ctx.input, "text") ??
      workflowInputToPrettyJson(ctx.input);

    ctx.log.info("Starting analysis", {
      inputLength: sourceText.length
    });

    const retrieved = await ctx.memory.retrieve({
      query: "project workflow summary",
      taskType: this.memoryTaskType,
      phase: this.memoryPhase
    });

    const summaryRecordId = `memory.workflow.summary.${ctx.workflowId}.analyze`;
    const summary = summarizeText(sourceText);
    const workflowSummary: WorkflowMemory = {
      workflowId: ctx.workflowId,
      currentStep: this.name,
      history: [],
      contextSummary: summary
    };

    await ctx.memory.write({
      id: summaryRecordId,
      shard: "workflow",
      kind: "summary",
      payload: workflowSummary,
      description: "Summary produced by analyze task",
      keywords: ["summary", "analysis", "workflow", "report"],
      importance: 0.9,
      workflowId: ctx.workflowId,
      runId: ctx.runId,
      sourceTask: this.name,
      phase: this.memoryPhase,
      taskType: this.memoryTaskType
    });
    ctx.log.success("Stored analysis summary", {
      retrievalHitCount: retrieved.hits.length
    });

    return {
      status: "success",
      output: {
        summaryRecordId,
        retrievalHitCount: retrieved.hits.length,
        summary
      }
    };
  }
}

class PublishReportTask extends Task {
  name = "publish";
  memoryPhase = "EXECUTION" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    ctx.log.info("Publishing report artifact");
    const summaryRecord = await ctx.memory.get(
      `memory.workflow.summary.${ctx.workflowId}.analyze`,
    );
    const summary = summaryRecord && "contextSummary" in summaryRecord.payload
      ? summaryRecord.payload.contextSummary
      : "No summary";
    const report = [
      "# Cycle Report",
      "",
      `- Workflow: ${ctx.workflowId}`,
      `- Summary: ${summary}`,
      `- Retrieved Context: ${ctx.memoryContext?.assembledContext ?? "none"}`
    ].join("\n");
    const artifact = await ctx.artifacts.create({
      name: "report.md",
      mimeType: "text/markdown",
      bytes: new TextEncoder().encode(`${report}\n`),
      meta: {
        task: this.name
      }
    });

    ctx.log.success("Artifact created", {
      artifactId: artifact.artifactId
    });

    return {
      status: "success",
      output: artifact
    };
  }
}

export const ReportWorkflow: WorkflowDefinition = {
  name: "report",
  start: "analyze",
  end: "end",
  tasks: {
    analyze: new AnalyzeTask(),
    publish: new PublishReportTask()
  },
  transitions: {
    analyze: {
      success: "publish",
      fail: "end"
    },
    publish: {
      success: "end",
      fail: "end"
    }
  }
};
