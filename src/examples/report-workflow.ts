import { Task } from "../task.js";
import type {
  MemoryPiece,
  TaskResult,
  WorkflowDefinition,
  WorkflowContext
} from "../types.js";

function summarizeText(text: string): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  if (trimmed.length <= 120) {
    return trimmed;
  }

  return `${trimmed.slice(0, 117)}...`;
}

class AnalyzeTask extends Task {
  name = "analyze";

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const sourceText =
      typeof ctx.input === "string"
        ? ctx.input
        : JSON.stringify(ctx.input, null, 2);

    ctx.log.info("Starting analysis", {
      inputLength: sourceText.length
    });

    const hits = await ctx.memory.hybridSearch("project workflow summary", {
      topK: 5,
      candidateKKeyword: 25,
      candidateKVector: 25,
      alpha: 0.6,
      beta: 0.4,
      fusion: "weighted_sum"
    });

    const summaryPiece: MemoryPiece = {
      key: `workflow.${ctx.workflowId}.task.analyze.summary`,
      scope: "workflow",
      category: "summary",
      description: "Summary produced by analyze task",
      keywords: ["summary", "analysis"],
      value: {
        summary: summarizeText(sourceText),
        retrievalHitCount: hits.length
      },
      importance: 0.7,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
      sourceTask: this.name
    };

    await ctx.memory.put(summaryPiece);
    ctx.log.success("Stored analysis summary", {
      retrievalHitCount: hits.length
    });

    return {
      status: "success",
      output: summaryPiece.value
    };
  }
}

class PublishReportTask extends Task {
  name = "publish";

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    ctx.log.info("Publishing report artifact");
    const summaryPiece = await ctx.memory.get(
      `workflow.${ctx.workflowId}.task.analyze.summary`
    );

    const summary = (summaryPiece?.value as { summary?: string } | undefined)?.summary ?? "No summary";
    const report = `# Cycle Report\n\n- Workflow: ${ctx.workflowId}\n- Summary: ${summary}\n`;
    const artifact = await ctx.artifacts.create({
      name: "report.md",
      mimeType: "text/markdown",
      bytes: new TextEncoder().encode(report),
      meta: {
        task: this.name
      }
    });

    await ctx.memory.put({
      key: `artifact.${artifact.artifactId}.summary`,
      scope: "workflow",
      category: "artifact",
      description: "Artifact metadata for generated report",
      keywords: ["artifact", "report"],
      value: {
        artifactId: artifact.artifactId,
        name: artifact.name,
        uri: artifact.uri
      },
      importance: 0.8,
      createdAt: ctx.now(),
      updatedAt: ctx.now(),
      sourceTask: this.name
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
