import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  AIProviderRequestError,
  Task,
  type AIChatRequest,
  type Artifact,
  type TaskResult,
  type WorkflowContext,
  type WorkflowDefinition,
  type WorkflowMemory
} from "agentic-task-kit";

import {
  buildLeflectWorkspaceSnapshot,
  type LeflectWorkspaceSnapshot
} from "./leflect-snapshot.js";

export type ModernizationInput = {
  workspaceRoot: string;
  outputDir: string;
  requestHeaders?: Record<string, string>;
  forceValidationFail?: boolean;
};

type AnalysisResult = {
  overview: string;
  javaContracts: string[];
  jspContracts: string[];
  crossLayerContracts: string[];
  preservationRules: string[];
  modernizationTargets: string[];
  risks: string[];
};

type ValidationResult = {
  approved: boolean;
  confidence: number;
  preservedContracts: string[];
  missingCoverage: string[];
  warnings: string[];
  blockingIssues: string[];
};

type RequirementsResult = {
  functionalRequirements: string[];
  compatibilityRequirements: string[];
  javaRequirements: string[];
  jspRequirements: string[];
  acceptanceCriteria: string[];
  unresolvedQuestions: string[];
};

type DesignResult = {
  architectureSummary: string;
  javaDesignDecisions: string[];
  jspDesignDecisions: string[];
  compatibilityNotes: string[];
  migrationSequence: string[];
  testStrategy: string[];
};

type ReimplementationResult = {
  javaFiles: Array<{
    path: string;
    content: string;
  }>;
  jspFiles: Array<{
    path: string;
    content: string;
  }>;
  migrationNotes: string[];
};

function requireInput(input: WorkflowContext["input"]): ModernizationInput {
  if (!(input instanceof Map)) {
    throw new Error("Sample input must be a workflow input map.");
  }

  const workspaceRoot = input.get("workspaceRoot");
  const outputDir = input.get("outputDir");
  const requestHeaders = input.get("requestHeaders");
  const forceValidationFail = input.get("forceValidationFail");

  if (typeof workspaceRoot !== "string") {
    throw new Error("Sample input is missing `workspaceRoot`.");
  }
  if (typeof outputDir !== "string") {
    throw new Error("Sample input is missing `outputDir`.");
  }

  return {
    workspaceRoot,
    outputDir,
    ...(requestHeaders && typeof requestHeaders === "object" && !Array.isArray(requestHeaders)
      ? { requestHeaders: requestHeaders as Record<string, string> }
      : {}),
    ...(typeof forceValidationFail === "boolean" ? { forceValidationFail } : {})
  };
}

function workflowRecordId(
  ctx: WorkflowContext,
  suffix: string,
  kind: "raw" | "summary" = "summary"
): string {
  return `memory.workflow.${kind}.${ctx.workflowId}.${suffix}`;
}

async function writeUtf8(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function normalizeText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function summarizeText(text: string, limit = 700): string {
  const normalized = normalizeText(text);
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 3)}...`;
}

function extractJsonBlock(text: string): string {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1);
  }

  return trimmed;
}

function parseJsonObject<T>(text: string, label: string): T {
  try {
    return JSON.parse(extractJsonBlock(text)) as T;
  } catch (error) {
    throw new Error(
      `${label} JSON parsing failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

async function parseStructuredJson<T>(
  ctx: WorkflowContext,
  input: ModernizationInput,
  text: string,
  label: string,
  schemaHint: string
): Promise<T> {
  try {
    return parseJsonObject<T>(text, label);
  } catch (error) {
    const originalMessage = error instanceof Error ? error.message : String(error);

    ctx.log.warn("Malformed JSON response detected; requesting repair", {
      label,
      error: originalMessage
    });

    const repairResponse = await ctx.ai.chat(
      withOptionalHttp(input, {
        temperature: 0,
        messages: [
          {
            role: "developer",
            content:
              "주어진 텍스트를 엄격한 JSON object 로 복원한다. 의미를 새로 추가하지 말고 문법만 보수한다. 응답은 JSON object 만 반환한다."
          },
          {
            role: "user",
            content: [`label: ${label}`, `schema: ${schemaHint}`, "", "broken text:", text].join("\n")
          }
        ]
      })
    );

    try {
      return parseJsonObject<T>(repairResponse.outputText, `${label} repaired`);
    } catch (repairError) {
      const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
      throw new Error(
        `${label} JSON parsing failed after repair attempt: ${originalMessage}; repair error: ${repairMessage}`
      );
    }
  }
}

function requestHttpOptions(input: ModernizationInput): AIChatRequest["http"] {
  return input.requestHeaders ? { headers: input.requestHeaders } : undefined;
}

function withOptionalHttp(
  input: ModernizationInput,
  request: Omit<AIChatRequest, "http">
): AIChatRequest {
  const http = requestHttpOptions(input);
  return http ? { ...request, http } : request;
}

function toTaskFailure(taskName: string, error: unknown): TaskResult {
  if (error instanceof AIProviderRequestError) {
    return {
      status: "fail",
      error: {
        message: `${taskName} provider request failed: ${error.message}`,
        code: "AI_PROVIDER_REQUEST_ERROR",
        details: error.toJSON()
      }
    };
  }

  return {
    status: "fail",
    error: {
      message: error instanceof Error ? error.message : String(error)
    }
  };
}

async function runStreamingChat(
  ctx: WorkflowContext,
  request: AIChatRequest
): Promise<string> {
  let stream: Awaited<ReturnType<typeof ctx.ai.chatStream>> | undefined;

  try {
    stream = await ctx.ai.chatStream(request);
    let chunkCount = 0;

    for await (const chunk of stream) {
      if (!chunk.deltaText) {
        continue;
      }

      chunkCount += 1;
      if (chunkCount === 1 || chunkCount % 10 === 0) {
        ctx.log.debug("Streaming AI response", {
          task: ctx.memoryContext?.taskName ?? null,
          chunkCount,
          outputLength: chunk.outputText.length
        });
      }
    }

    const response = await stream.finalResponse;
    return response.outputText;
  } catch (error) {
    if (stream) {
      await stream.finalResponse.catch(() => undefined);
    }
    throw error;
  }
}

async function writeWorkflowRecord(
  ctx: WorkflowContext,
  suffix: string,
  description: string,
  value: unknown,
  kind: "raw" | "summary" = "summary"
): Promise<void> {
  await ctx.memory.write({
    id: workflowRecordId(ctx, suffix, kind),
    shard: "workflow",
    kind,
    payload: {
      workflowId: ctx.workflowId,
      currentStep: suffix,
      history: [],
      contextSummary: typeof value === "string" ? value : JSON.stringify(value, null, 2)
    } satisfies WorkflowMemory,
    description,
    keywords: ["sample-project", suffix, kind, "java", "jsp"],
    importance: 0.95,
    workflowId: ctx.workflowId,
    runId: ctx.runId,
    sourceTask: suffix
  });
}

async function readWorkflowJson<T>(
  ctx: WorkflowContext,
  suffix: string,
  kind: "raw" | "summary" = "summary"
): Promise<T> {
  const record = await ctx.memory.get(workflowRecordId(ctx, suffix, kind));
  if (!record || !("contextSummary" in record.payload)) {
    throw new Error(`Required workflow record not found: ${suffix}`);
  }

  return JSON.parse(record.payload.contextSummary) as T;
}

async function writeOutputArtifact(
  ctx: WorkflowContext,
  filePath: string,
  name: string,
  mimeType: string,
  content: string,
  meta?: Record<string, unknown>
): Promise<Artifact> {
  await writeUtf8(filePath, content);

  return ctx.artifacts.create({
    name,
    mimeType,
    bytes: new TextEncoder().encode(content),
    meta: {
      filePath,
      ...meta
    }
  });
}

function snapshotForPrompt(snapshot: LeflectWorkspaceSnapshot): string {
  return JSON.stringify(
    {
      workspaceName: snapshot.workspaceName,
      analysisEngine: snapshot.analysisEngine,
      summaryCounts: snapshot.summaryCounts,
      labels: snapshot.labels,
      stageReport: snapshot.stageReport,
      jspImpacts: snapshot.jspImpacts,
      unresolvedDiagnostics: snapshot.unresolvedDiagnostics,
      javaFiles: snapshot.javaFiles,
      jspFiles: snapshot.jspFiles
    },
    null,
    2
  );
}

class AnalyzeAssetsTask extends Task {
  name = "analyzeAssets";
  memoryPhase = "PLANNING" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireInput(ctx.input);
    const snapshot = await buildLeflectWorkspaceSnapshot(input.workspaceRoot);
    const manualContext = await ctx.memory.retrieve({
      query: "java jsp modernization preserve public contract request attribute status literals",
      taskType: this.memoryTaskType,
      phase: this.memoryPhase
    });
    const snapshotPath = resolve(input.outputDir, "00-leflect-snapshot.json");

    await writeOutputArtifact(
      ctx,
      snapshotPath,
      "00-leflect-snapshot.json",
      "application/json",
      `${JSON.stringify(snapshot, null, 2)}\n`,
      { task: this.name }
    );
    await writeWorkflowRecord(
      ctx,
      "leflect-snapshot",
      "Structured Leflect snapshot for sample-project Java/JSP modernization example",
      snapshot,
      "raw"
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
                "당신은 Java/JSP 레거시 현대화 분석가다. raw source 전문을 재구성하지 말고 제공된 Leflect structured snapshot 만 근거로 판단한다. JSON 만 반환하고 키는 overview, javaContracts, jspContracts, crossLayerContracts, preservationRules, modernizationTargets, risks 로 고정한다."
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
                summarizeText(manualContext.assembledContext || "none", 500)
              ].join("\n")
            }
          ]
        })
      );

      const analysis = await parseStructuredJson<AnalysisResult>(
        ctx,
        input,
        outputText,
        "analysis",
        "overview:string, javaContracts:string[], jspContracts:string[], crossLayerContracts:string[], preservationRules:string[], modernizationTargets:string[], risks:string[]"
      );
      const analysisPath = resolve(input.outputDir, "01-analysis.json");

      await writeOutputArtifact(
        ctx,
        analysisPath,
        "01-analysis.json",
        "application/json",
        `${JSON.stringify(analysis, null, 2)}\n`,
        { task: this.name }
      );
      await writeWorkflowRecord(
        ctx,
        "analysis",
        "Analysis result for sample-project Java/JSP modernization example",
        analysis
      );

      ctx.log.success("Completed Java/JSP analysis stage", {
        workspaceRoot: input.workspaceRoot,
        javaFileCount: snapshot.javaFiles.length,
        jspFileCount: snapshot.jspFiles.length
      });

      return {
        status: "success",
        output: {
          snapshotPath,
          analysisPath
        }
      };
    } catch (error) {
      ctx.log.error("Java/JSP analysis stage failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return toTaskFailure(this.name, error);
    }
  }
}

class ValidateAnalysisTask extends Task {
  name = "validateAnalysis";
  memoryPhase = "REFLECTION" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireInput(ctx.input);
    const snapshot = await readWorkflowJson<LeflectWorkspaceSnapshot>(ctx, "leflect-snapshot", "raw");
    const analysis = await readWorkflowJson<AnalysisResult>(ctx, "analysis");
    const validationPath = resolve(input.outputDir, "02-validation.json");

    if (input.forceValidationFail) {
      const forced: ValidationResult = {
        approved: false,
        confidence: 0,
        preservedContracts: [],
        missingCoverage: ["Forced failure path for validation stage."],
        warnings: ["Use this mode to verify fail rendering and recovery artifact output."],
        blockingIssues: ["Forced validation failure requested by SAMPLE_FORCE_VALIDATION_FAIL."]
      };

      await writeOutputArtifact(
        ctx,
        validationPath,
        "02-validation.json",
        "application/json",
        `${JSON.stringify(forced, null, 2)}\n`,
        { task: this.name, forced: true }
      );
      await writeWorkflowRecord(
        ctx,
        "validation",
        "Forced validation failure for sample-project Java/JSP modernization example",
        forced
      );

      ctx.log.warn("Forced validation failure requested", {
        validationPath
      });

      return {
        status: "fail",
        error: {
            message:
              forced.blockingIssues[0] ??
              "Forced validation failure requested by SAMPLE_FORCE_VALIDATION_FAIL.",
            code: "FORCED_VALIDATION_FAILURE",
            details: forced
          }
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
                "당신은 Java/JSP 현대화 분석 검증 담당자다. Leflect snapshot 과 분석 결과를 비교해 누락과 보존 규칙을 점검한다. JSON 만 반환하고 키는 approved, confidence, preservedContracts, missingCoverage, warnings, blockingIssues 로 고정한다."
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
                summarizeText(ctx.memoryContext?.assembledContext ?? "none", 500)
              ].join("\n")
            }
          ]
        })
      );

      const validation = await parseStructuredJson<ValidationResult>(
        ctx,
        input,
        response.outputText,
        "validation",
        "approved:boolean, confidence:number, preservedContracts:string[], missingCoverage:string[], warnings:string[], blockingIssues:string[]"
      );

      await writeOutputArtifact(
        ctx,
        validationPath,
        "02-validation.json",
        "application/json",
        `${JSON.stringify(validation, null, 2)}\n`,
        { task: this.name }
      );
      await writeWorkflowRecord(
        ctx,
        "validation",
        "Validation result for sample-project Java/JSP modernization example",
        validation
      );

      if (!validation.approved) {
        ctx.log.warn("Validation rejected the modernization analysis", {
          blockingIssueCount: validation.blockingIssues.length
        });
        return {
          status: "fail",
          error: {
            message:
              validation.blockingIssues[0] ?? "Validation rejected the modernization analysis.",
            code: "VALIDATION_REJECTED",
            details: validation
          }
        };
      }

      ctx.log.success("Validation approved the analysis", {
        confidence: validation.confidence,
        preservedContractCount: validation.preservedContracts.length
      });

      return {
        status: "success",
        output: {
          validationPath
        }
      };
    } catch (error) {
      ctx.log.error("Validation stage failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return toTaskFailure(this.name, error);
    }
  }
}

class ExtractRequirementsTask extends Task {
  name = "extractRequirements";
  memoryPhase = "PLANNING" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireInput(ctx.input);
    const snapshot = await readWorkflowJson<LeflectWorkspaceSnapshot>(ctx, "leflect-snapshot", "raw");
    const analysis = await readWorkflowJson<AnalysisResult>(ctx, "analysis");
    const validation = await readWorkflowJson<ValidationResult>(ctx, "validation");
    const requirementsContext = await ctx.memory.retrieve({
      query: "java jsp modernization requirements preserve contracts compatibility acceptance criteria",
      taskType: this.memoryTaskType,
      phase: this.memoryPhase
    });

    try {
      const response = await ctx.ai.chat(
        withOptionalHttp(input, {
          temperature: 0.1,
          messages: [
            {
              role: "developer",
              content:
                "당신은 Java/JSP 현대화 요구사항 분석가다. Leflect snapshot, 분석 결과, 검증 결과를 기반으로 재구현 요구사항을 정리한다. JSON 만 반환하고 키는 functionalRequirements, compatibilityRequirements, javaRequirements, jspRequirements, acceptanceCriteria, unresolvedQuestions 로 고정한다."
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
                summarizeText(requirementsContext.assembledContext || "none", 500)
              ].join("\n")
            }
          ]
        })
      );

      const requirements = await parseStructuredJson<RequirementsResult>(
        ctx,
        input,
        response.outputText,
        "requirements",
        "functionalRequirements:string[], compatibilityRequirements:string[], javaRequirements:string[], jspRequirements:string[], acceptanceCriteria:string[], unresolvedQuestions:string[]"
      );
      const requirementsPath = resolve(input.outputDir, "03-requirements.json");

      await writeOutputArtifact(
        ctx,
        requirementsPath,
        "03-requirements.json",
        "application/json",
        `${JSON.stringify(requirements, null, 2)}\n`,
        { task: this.name }
      );
      await writeWorkflowRecord(
        ctx,
        "requirements",
        "Requirements result for sample-project Java/JSP modernization example",
        requirements
      );

      ctx.log.success("Extracted modernization requirements", {
        functionalRequirementCount: requirements.functionalRequirements.length,
        compatibilityRequirementCount: requirements.compatibilityRequirements.length
      });

      return {
        status: "success",
        output: {
          requirementsPath
        }
      };
    } catch (error) {
      ctx.log.error("Requirements extraction stage failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return toTaskFailure(this.name, error);
    }
  }
}

class DesignModernizationTask extends Task {
  name = "designModernization";
  memoryPhase = "PLANNING" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireInput(ctx.input);
    const snapshot = await readWorkflowJson<LeflectWorkspaceSnapshot>(ctx, "leflect-snapshot", "raw");
    const analysis = await readWorkflowJson<AnalysisResult>(ctx, "analysis");
    const validation = await readWorkflowJson<ValidationResult>(ctx, "validation");
    const requirements = await readWorkflowJson<RequirementsResult>(ctx, "requirements");
    const designContext = await ctx.memory.retrieve({
      query: "java controller jsp view modernization design compatibility request attributes status literals",
      taskType: this.memoryTaskType,
      phase: this.memoryPhase
    });

    try {
      const response = await ctx.ai.chat(
        withOptionalHttp(input, {
          temperature: 0.15,
          messages: [
            {
              role: "developer",
              content:
                "당신은 Java/JSP 현대화 설계자다. Leflect snapshot, 분석 결과, 검증 결과, 요구사항을 바탕으로 재구현 설계를 만든다. JSON 만 반환하고 키는 architectureSummary, javaDesignDecisions, jspDesignDecisions, compatibilityNotes, migrationSequence, testStrategy 로 고정한다."
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
                summarizeText(designContext.assembledContext || "none", 500)
              ].join("\n")
            }
          ]
        })
      );

      const design = await parseStructuredJson<DesignResult>(
        ctx,
        input,
        response.outputText,
        "design",
        "architectureSummary:string, javaDesignDecisions:string[], jspDesignDecisions:string[], compatibilityNotes:string[], migrationSequence:string[], testStrategy:string[]"
      );
      const designPath = resolve(input.outputDir, "04-design.json");

      await writeOutputArtifact(
        ctx,
        designPath,
        "04-design.json",
        "application/json",
        `${JSON.stringify(design, null, 2)}\n`,
        { task: this.name }
      );
      await writeWorkflowRecord(
        ctx,
        "design",
        "Design result for sample-project Java/JSP modernization example",
        design
      );

      ctx.log.success("Produced modernization design", {
        designPath,
        migrationSteps: design.migrationSequence.length
      });

      return {
        status: "success",
        output: {
          designPath
        }
      };
    } catch (error) {
      ctx.log.error("Design stage failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return toTaskFailure(this.name, error);
    }
  }
}

class ReimplementAssetsTask extends Task {
  name = "reimplementAssets";
  memoryPhase = "EXECUTION" as const;
  memoryTaskType = "workflow" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireInput(ctx.input);
    const snapshot = await readWorkflowJson<LeflectWorkspaceSnapshot>(ctx, "leflect-snapshot", "raw");
    const analysis = await readWorkflowJson<AnalysisResult>(ctx, "analysis");
    const validation = await readWorkflowJson<ValidationResult>(ctx, "validation");
    const requirements = await readWorkflowJson<RequirementsResult>(ctx, "requirements");
    const design = await readWorkflowJson<DesignResult>(ctx, "design");
    const reimplementationContext = await ctx.memory.retrieve({
      query: "reimplement java jsp preserve request attributes status literals compatibility requirements",
      taskType: this.memoryTaskType,
      phase: this.memoryPhase
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
                "당신은 Java/JSP 재구현 담당자다. raw source 전문이 아니라 Leflect snapshot, 분석, 검증, 요구사항, 설계만 근거로 결과를 만든다. JSON 만 반환하고 키는 javaFiles, jspFiles, migrationNotes 로 고정한다. javaFiles 와 jspFiles 는 각각 { path, content } 배열이다. 보존 규칙과 request attribute 이름, status literal, externally visible contract 를 유지해야 한다."
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
                summarizeText(reimplementationContext.assembledContext || "none", 500)
              ].join("\n")
            }
          ]
        })
      );

      const reimplementation = await parseStructuredJson<ReimplementationResult>(
        ctx,
        input,
        outputText,
        "reimplementation",
        "javaFiles:{path:string,content:string}[], jspFiles:{path:string,content:string}[], migrationNotes:string[]"
      );
      const manifestPath = resolve(input.outputDir, "05-reimplementation.json");
      const reimplementationRoot = resolve(input.outputDir, "06-reimplementation");

      for (const javaFile of reimplementation.javaFiles) {
        await writeOutputArtifact(
          ctx,
          resolve(reimplementationRoot, javaFile.path),
          javaFile.path,
          "text/x-java-source",
          `${javaFile.content.trim()}\n`,
          {
            task: this.name,
            kind: "java"
          }
        );
      }

      for (const jspFile of reimplementation.jspFiles) {
        await writeOutputArtifact(
          ctx,
          resolve(reimplementationRoot, jspFile.path),
          jspFile.path,
          "text/x-jsp",
          `${jspFile.content.trim()}\n`,
          {
            task: this.name,
            kind: "jsp"
          }
        );
      }

      await writeOutputArtifact(
        ctx,
        manifestPath,
        "05-reimplementation.json",
        "application/json",
        `${JSON.stringify(reimplementation, null, 2)}\n`,
        { task: this.name }
      );
      await writeWorkflowRecord(
        ctx,
        "reimplementation",
        "Reimplementation manifest for sample-project Java/JSP modernization example",
        reimplementation
      );

      ctx.log.success("Generated Java/JSP reimplementation", {
        manifestPath,
        javaFileCount: reimplementation.javaFiles.length,
        jspFileCount: reimplementation.jspFiles.length
      });

      return {
        status: "success",
        output: {
          manifestPath,
          reimplementationRoot
        }
      };
    } catch (error) {
      ctx.log.error("Reimplementation stage failed", {
        error: error instanceof Error ? error.message : String(error)
      });
      return toTaskFailure(this.name, error);
    }
  }
}

class RecoverTask extends Task {
  name = "recover";
  memoryPhase = "RECOVERY" as const;
  memoryTaskType = "debug" as const;

  async run(ctx: WorkflowContext): Promise<TaskResult> {
    const input = requireInput(ctx.input);
    const lifecycle = await ctx.memory.runLifecycle(ctx.now());
    const recoveryContext = await ctx.memory.retrieve({
      query: "java jsp recovery remediation preserve contract validation requirements design blockers",
      taskType: this.memoryTaskType,
      phase: this.memoryPhase
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
      `- compressedIds: ${lifecycle.compressedIds.join(", ") || "-"}`
    ].join("\n");

    await writeOutputArtifact(ctx, recoveryPath, "09-recovery.md", "text/markdown", `${note}\n`, {
      task: this.name
    });
    await writeWorkflowRecord(
      ctx,
      "recovery",
      "Recovery note for sample-project Java/JSP modernization example",
      note
    );

    ctx.log.warn("Recovery artifact created", {
      recoveryPath,
      archivedIds: lifecycle.archivedIds
    });

    return {
      status: "success",
      output: {
        recoveryPath
      }
    };
  }
}

export const JavaJspModernizationWorkflow: WorkflowDefinition = {
  name: "sample-project-java-jsp-modernization",
  start: "analyze",
  end: "end",
  tasks: {
    analyze: new AnalyzeAssetsTask(),
    validate: new ValidateAnalysisTask(),
    requirements: new ExtractRequirementsTask(),
    design: new DesignModernizationTask(),
    reimplement: new ReimplementAssetsTask(),
    recover: new RecoverTask()
  },
  transitions: {
    analyze: {
      success: "validate",
      fail: "recover"
    },
    validate: {
      success: "requirements",
      fail: "recover"
    },
    requirements: {
      success: "design",
      fail: "recover"
    },
    design: {
      success: "reimplement",
      fail: "recover"
    },
    reimplement: {
      success: "end",
      fail: "recover"
    },
    recover: {
      success: "end",
      fail: "end"
    }
  }
};
