import {
  AIProviderRequestError,
  type AIChatRequest,
  type Artifact,
  type TaskResult,
  type WorkflowContext,
  type WorkflowMemory,
} from "agentic-task-kit";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type LeflectWorkspaceSnapshot } from "../leflect-snapshot.js";
import type { ModernizationInput } from "./types.js";

export function requireInput(input: WorkflowContext["input"]): ModernizationInput {
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
    ...(typeof forceValidationFail === "boolean" ? { forceValidationFail } : {}),
  };
}

function workflowRecordId(
  ctx: WorkflowContext,
  suffix: string,
  kind: "raw" | "summary" = "summary",
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

export function summarizeText(text: string, limit = 700): string {
  const normalized = normalizeText(text);
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit - 3)}...`;
}

function extractJsonBlock(text: string): string {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?\s*/iu, "")
    .replace(/\s*```$/u, "");
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
      `${label} JSON parsing failed: ${error instanceof Error ? error.message : String(error)}`,
      {
        ...(error instanceof Error ? { cause: error } : {}),
      },
    );
  }
}

export async function parseStructuredJson<T>(
  ctx: WorkflowContext,
  input: ModernizationInput,
  text: string,
  label: string,
  schemaHint: string,
): Promise<T> {
  try {
    return parseJsonObject<T>(text, label);
  } catch (error) {
    const originalMessage = error instanceof Error ? error.message : String(error);

    ctx.log.warn("Malformed JSON response detected; requesting repair", {
      label,
      error: originalMessage,
    });

    const repairResponse = await ctx.ai.chat(
      withOptionalHttp(input, {
        temperature: 0,
        messages: [
          {
            role: "developer",
            content:
              "주어진 텍스트를 엄격한 JSON object 로 복원한다. 의미를 새로 추가하지 말고 문법만 보수한다. 응답은 JSON object 만 반환한다.",
          },
          {
            role: "user",
            content: [`label: ${label}`, `schema: ${schemaHint}`, "", "broken text:", text].join(
              "\n",
            ),
          },
        ],
      }),
    );

    try {
      return parseJsonObject<T>(repairResponse.outputText, `${label} repaired`);
    } catch (repairError) {
      const repairMessage =
        repairError instanceof Error ? repairError.message : String(repairError);
      throw new Error(
        `${label} JSON parsing failed after repair attempt: ${originalMessage}; repair error: ${repairMessage}`,
        {
          ...(repairError instanceof Error ? { cause: repairError } : {}),
        },
      );
    }
  }
}

function requestHttpOptions(input: ModernizationInput): AIChatRequest["http"] {
  return input.requestHeaders ? { headers: input.requestHeaders } : undefined;
}

export function withOptionalHttp(
  input: ModernizationInput,
  request: Omit<AIChatRequest, "http">,
): AIChatRequest {
  const http = requestHttpOptions(input);
  return http ? { ...request, http } : request;
}

export function toTaskFailure(taskName: string, error: unknown): TaskResult {
  if (error instanceof AIProviderRequestError) {
    return {
      status: "fail",
      error: {
        message: `${taskName} provider request failed: ${error.message}`,
        code: "AI_PROVIDER_REQUEST_ERROR",
        details: error.toJSON(),
      },
    };
  }

  return {
    status: "fail",
    error: {
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof Error
        ? {
            details: {
              name: error.name,
              message: error.message,
              stack: error.stack,
              ...("cause" in error ? { cause: (error as { cause?: unknown }).cause } : {}),
            },
          }
        : {}),
    },
  };
}

export async function runStreamingChat(
  ctx: WorkflowContext,
  request: AIChatRequest,
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
          outputLength: chunk.outputText.length,
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

export async function writeWorkflowRecord(
  ctx: WorkflowContext,
  suffix: string,
  description: string,
  value: unknown,
  kind: "raw" | "summary" = "summary",
): Promise<void> {
  await ctx.memory.write({
    id: workflowRecordId(ctx, suffix, kind),
    shard: "workflow",
    kind,
    payload: {
      workflowId: ctx.workflowId,
      currentStep: suffix,
      history: [],
      contextSummary: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    } satisfies WorkflowMemory,
    description,
    keywords: ["sample-project", suffix, kind, "java", "jsp"],
    importance: 0.95,
    workflowId: ctx.workflowId,
    runId: ctx.runId,
    sourceTask: suffix,
  });
}

export async function readWorkflowJson<T>(
  ctx: WorkflowContext,
  suffix: string,
  kind: "raw" | "summary" = "summary",
): Promise<T> {
  const record = await ctx.memory.get(workflowRecordId(ctx, suffix, kind));
  if (!record || !("contextSummary" in record.payload)) {
    throw new Error(`Required workflow record not found: ${suffix}`);
  }

  return JSON.parse(record.payload.contextSummary) as T;
}

export async function writeOutputArtifact(
  ctx: WorkflowContext,
  filePath: string,
  name: string,
  mimeType: string,
  content: string,
  meta?: Record<string, unknown>,
): Promise<Artifact> {
  await writeUtf8(filePath, content);

  return ctx.artifacts.create({
    name,
    mimeType,
    bytes: new TextEncoder().encode(content),
    meta: {
      filePath,
      ...meta,
    },
  });
}

export function snapshotForPrompt(snapshot: LeflectWorkspaceSnapshot): string {
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
      jspFiles: snapshot.jspFiles,
    },
    null,
    2,
  );
}
