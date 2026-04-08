import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { analyzeWorkspace } from "@leflect-java/cli";
import { defineConfig } from "@leflect-java/core";

type LeflectSummaryCounts = Record<string, number>;

export type OrderedFlowStep = {
  sequence: number;
  kind: string;
  snippet: string;
  branchPath: string[];
  targetText?: string;
  resolvedMethodId?: string;
  resolvedClassId?: string;
  lineRange?: {
    startLine?: number;
    endLine?: number;
  };
};

export type JavaFileSnapshot = {
  path: string;
  packageName: string;
  imports: string[];
  classNames: string[];
  fieldDeclarations: string[];
  methodSignatures: string[];
  orderedFlows: Array<{
    methodId: string;
    signature: string;
    steps: OrderedFlowStep[];
  }>;
  callTargets: string[];
  validationRules: string[];
  sideEffects: string[];
  stringLiterals: string[];
  statusLiterals: string[];
};

export type JspFileSnapshot = {
  path: string;
  htmlTags: string[];
  textNodes: string[];
  scriptlets: string[];
  expressionCodes: string[];
  methodCalls: string[];
  requestAttributes: string[];
  semanticSummary: Record<string, number>;
  diagnostics: Array<{
    severity?: string;
    summary?: string;
    message?: string;
  }>;
};

export type LeflectWorkspaceSnapshot = {
  workspaceName: string;
  sourceRoot: string;
  analysisEngine: string;
  summaryCounts: LeflectSummaryCounts;
  labels: Record<string, unknown>;
  stageReport: Array<{
    stage: string;
    status: string;
    processedFiles?: number;
    totalFiles?: number;
  }>;
  jspImpacts: Array<{
    jspPath: string;
    labels: string[];
    javaTargets: string[];
    unresolvedTargets: string[];
  }>;
  unresolvedDiagnostics: Array<{
    stage?: string;
    severity?: string;
    path?: string;
    summary?: string;
    message?: string;
  }>;
  javaFiles: JavaFileSnapshot[];
  jspFiles: JspFileSnapshot[];
};

type JsonValue = Record<string, unknown> | Array<unknown>;

function normalizeSnippet(value: unknown): string {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function extractQuotedValues(value: string): string[] {
  return [...value.matchAll(/"([^"\n]*)"/gu)]
    .map((match) => match[1] ?? "")
    .filter(Boolean);
}

function optionalStringField<K extends string>(
  key: K,
  value: unknown,
): Partial<Record<K, string>> {
  if (value === undefined || value === null) {
    return {};
  }

  const normalized = String(value).trim();
  return normalized ? ({ [key]: normalized } as Partial<Record<K, string>>) : {};
}

function optionalNumberField<K extends string>(
  key: K,
  value: number | undefined,
): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, number>>);
}

function toLineRange(value: unknown): OrderedFlowStep["lineRange"] | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as {
    startLine?: number;
    endLine?: number;
    line?: number;
  };

  if (
    candidate.startLine === undefined &&
    candidate.endLine === undefined &&
    candidate.line === undefined
  ) {
    return undefined;
  }

  const startLine = candidate.startLine ?? candidate.line;

  return {
    ...optionalNumberField("startLine", startLine),
    ...optionalNumberField("endLine", candidate.endLine),
  };
}

async function readJson<T extends JsonValue>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

function formatField(field: Record<string, unknown>): string {
  const modifiers = Array.isArray(field.modifiers)
    ? field.modifiers.join(" ")
    : "";
  const type = String(
    field.type ?? field.declaredType ?? "Object",
  );
  const name = String(field.name ?? "field");
  const initializer = field.initializerSnippet
    ? ` = ${String(field.initializerSnippet)}`
    : "";
  const lifetime = field.lifetime ? ` // lifetime=${String(field.lifetime)}` : "";
  return `${[modifiers, type, name].filter(Boolean).join(" ")}${initializer};${lifetime}`;
}

function formatMethod(method: Record<string, unknown>): string {
  const returnType = String(method.returnType ?? "void");
  const name = String(method.name ?? "method");
  const parameters = Array.isArray(method.parameters)
    ? method.parameters.map((value) => String(value)).join(", ")
    : "";
  return `${returnType} ${name}(${parameters})`;
}

function buildJavaFileSnapshot(metadata: Record<string, unknown>): JavaFileSnapshot {
  const methods = Array.isArray(metadata.methods)
    ? (metadata.methods as Record<string, unknown>[])
    : [];
  const fields = Array.isArray(metadata.fields)
    ? (metadata.fields as Record<string, unknown>[])
    : [];
  const calls = Array.isArray(metadata.calls)
    ? (metadata.calls as Record<string, unknown>[])
    : [];

  const snippets = [
    ...fields
      .map((field) => normalizeSnippet(field.initializerSnippet))
      .filter(Boolean),
    ...methods.flatMap((method) =>
      Array.isArray(method.orderedSteps)
        ? (method.orderedSteps as Record<string, unknown>[])
            .map((step) => normalizeSnippet(step.snippet))
            .filter(Boolean)
        : [],
    ),
    ...calls.map((call) => normalizeSnippet(call.snippet)).filter(Boolean),
  ];
  const stringLiterals = unique(snippets.flatMap((snippet) => extractQuotedValues(snippet))).slice(
    0,
    80,
  );

  return {
    path: String(metadata.path ?? ""),
    packageName: String(metadata.packageName ?? ""),
    imports: Array.isArray(metadata.imports)
      ? metadata.imports.map((value) => String(value))
      : [],
    classNames: Array.isArray(metadata.classes)
      ? (metadata.classes as Record<string, unknown>[]).map((entry) =>
          String(entry.id ?? entry.name ?? "type"),
        )
      : [],
    fieldDeclarations: fields.map((field) => formatField(field)),
    methodSignatures: methods.map((method) => formatMethod(method)),
    orderedFlows: methods.map((method) => ({
      methodId: String(method.id ?? method.name ?? "method"),
      signature: formatMethod(method),
      steps: Array.isArray(method.orderedSteps)
        ? (method.orderedSteps as Record<string, unknown>[]).map((step, index) => {
            const call =
              step.call && typeof step.call === "object"
                ? (step.call as Record<string, unknown>)
                : undefined;
            const lineRange = toLineRange(step.lineRange);

            return {
              sequence: index + 1,
              kind: String(step.kind ?? "step"),
              snippet: normalizeSnippet(step.snippet) || String(step.kind ?? "step"),
              branchPath: Array.isArray(step.branchPath)
                ? step.branchPath.map((value) => String(value))
                : [],
              ...optionalStringField("targetText", call?.targetText),
              ...optionalStringField("resolvedMethodId", call?.resolvedMethodId),
              ...optionalStringField("resolvedClassId", call?.resolvedClassId),
              ...(lineRange ? { lineRange } : {}),
            };
          })
        : [],
    })),
    callTargets: unique(
      calls.map((call) =>
        String(
          call.resolvedMethodId ??
            call.targetText ??
            call.rawTarget ??
            call.methodName ??
            "",
        ),
      ),
    ).slice(0, 60),
    validationRules: unique(
      methods.flatMap((method) =>
        Array.isArray(method.orderedSteps)
          ? (method.orderedSteps as Record<string, unknown>[])
              .filter((step) =>
                ["branch", "return"].includes(String(step.kind ?? "")),
              )
              .map((step) => normalizeSnippet(step.snippet))
              .filter(Boolean)
          : [],
      ),
    ).slice(0, 60),
    sideEffects: unique(
      snippets.filter((snippet) =>
        /(put\(|add\(|setAttribute\(|sendRedirect\(|return )/u.test(snippet),
      ),
    ).slice(0, 60),
    stringLiterals,
    statusLiterals: unique(
      stringLiterals.filter((value) => /^[A-Z0-9_:-]{3,}$/u.test(value)),
    ).slice(0, 40),
  };
}

function walkSemanticNode(
  node: Record<string, unknown>,
  htmlTags: string[],
  textNodes: string[],
  expressionCodes: string[],
): void {
  const kind = String(node.kind ?? "");
  if (kind === "HtmlElementNode" && node.tagName) {
    htmlTags.push(String(node.tagName));
  }
  if (kind === "TextNode" && node.text) {
    const text = normalizeSnippet(node.text);
    if (text.length > 0) {
      textNodes.push(text);
    }
  }
  if (kind === "ExpressionNode" && node.code) {
    expressionCodes.push(normalizeSnippet(node.code));
  }

  if (Array.isArray(node.children)) {
    for (const child of node.children as Record<string, unknown>[]) {
      walkSemanticNode(child, htmlTags, textNodes, expressionCodes);
    }
  }
}

function buildJspFileSnapshot(
  metadata: Record<string, unknown>,
  semanticAst: Record<string, unknown>,
): JspFileSnapshot {
  const htmlTags: string[] = [];
  const textNodes: string[] = [];
  const expressionCodes: string[] = [];
  const rootNode =
    semanticAst.root && typeof semanticAst.root === "object"
      ? (semanticAst.root as Record<string, unknown>)
      : undefined;

  if (rootNode) {
    walkSemanticNode(rootNode, htmlTags, textNodes, expressionCodes);
  }

  const scriptlets = Array.isArray(metadata.scriptlets)
    ? (metadata.scriptlets as Record<string, unknown>[])
        .map((entry) => normalizeSnippet(entry.code))
        .filter(Boolean)
    : [];
  const methodCalls = Array.isArray(metadata.methodCalls)
    ? (metadata.methodCalls as Record<string, unknown>[])
        .map((entry) => {
          const qualifier = entry.qualifier ? `${String(entry.qualifier)}.` : "";
          const methodName = String(entry.methodName ?? "method");
          const parameters = Array.isArray(entry.inputParameters)
            ? (entry.inputParameters as Record<string, unknown>[])
                .map((parameter) => String(parameter.value ?? ""))
                .join(", ")
            : "";
          return `${qualifier}${methodName}(${parameters})`;
        })
        .filter(Boolean)
    : [];

  return {
    path: String(metadata.path ?? ""),
    htmlTags: unique(htmlTags),
    textNodes: unique(textNodes).slice(0, 40),
    scriptlets: unique(scriptlets).slice(0, 40),
    expressionCodes: unique(expressionCodes).slice(0, 40),
    methodCalls: unique(methodCalls).slice(0, 40),
    requestAttributes: unique(
      [...scriptlets, ...expressionCodes, ...methodCalls].flatMap((value) =>
        extractQuotedValues(value),
      ),
    ).slice(0, 40),
    semanticSummary:
      metadata.semanticSummary && typeof metadata.semanticSummary === "object"
        ? (metadata.semanticSummary as Record<string, number>)
        : {},
    diagnostics: Array.isArray(semanticAst.diagnostics)
      ? (semanticAst.diagnostics as Record<string, unknown>[]).map((entry) => ({
          ...optionalStringField("severity", entry.severity),
          ...optionalStringField("summary", entry.summary),
          ...optionalStringField("message", entry.message),
        }))
      : [],
  };
}

async function readOptionalJson<T extends JsonValue>(path: string): Promise<T | null> {
  try {
    return await readJson<T>(path);
  } catch {
    return null;
  }
}

function serializeConfig(config: Record<string, unknown>): string {
  return [
    "import { defineConfig } from \"@leflect-java/core\";",
    "",
    `export default defineConfig(${JSON.stringify(config, null, 2)});`,
    "",
  ].join("\n");
}

export async function buildLeflectWorkspaceSnapshot(
  workspaceRoot: string,
): Promise<LeflectWorkspaceSnapshot> {
  const absoluteWorkspaceRoot = resolve(workspaceRoot);
  const tempParent = await mkdtemp(join(tmpdir(), "published-package-sample-"));
  const stagedRoot = join(tempParent, basename(absoluteWorkspaceRoot));

  try {
    await cp(absoluteWorkspaceRoot, stagedRoot, { recursive: true });

    const config = defineConfig({
      analysisOut: "./analysis",
      classpathDiscovery: {
        enabled: false,
      },
      java: {},
      jsp: {
        webappRoot: "src/main/webapp",
        astMode: "lightweight",
      },
    });
    const configPath = join(stagedRoot, "leflect.config.mjs");
    await writeFile(configPath, serializeConfig(config), "utf8");

    const analysisOut = join(stagedRoot, "analysis");
    const analyzeResult = await analyzeWorkspace({
      root: stagedRoot,
      configPath,
      analysisOut,
      incremental: false,
      jspAstMode: "lightweight",
    });

    const summary = await readJson<Record<string, unknown>>(
      join(analysisOut, "report", "summary.json"),
    );
    const unresolved =
      (await readOptionalJson<Record<string, unknown>>(
        join(analysisOut, "report", "unresolved.json"),
      )) ?? {};
    const javaFileManifest = await readJson<Array<Record<string, unknown>>>(
      join(analysisOut, "index", "java-files.json"),
    );
    const jspFileManifest = await readJson<Array<Record<string, unknown>>>(
      join(analysisOut, "index", "jsp-files.json"),
    );

    const javaFiles = await Promise.all(
      javaFileManifest.map(async (entry) =>
        buildJavaFileSnapshot(
          await readJson<Record<string, unknown>>(
            join(analysisOut, "index", String(entry.metadataPath ?? "")),
          ),
        ),
      ),
    );
    const jspFiles = await Promise.all(
      jspFileManifest.map(async (entry) => {
        const metadata = await readJson<Record<string, unknown>>(
          join(analysisOut, "index", String(entry.metadataPath ?? "")),
        );
        const semanticAst = await readJson<Record<string, unknown>>(
          join(analysisOut, String(entry.semanticAstPath ?? "")),
        );
        return buildJspFileSnapshot(metadata, semanticAst);
      }),
    );

    return {
      workspaceName: basename(absoluteWorkspaceRoot),
      sourceRoot: absoluteWorkspaceRoot,
      analysisEngine: "@leflect-java/cli@0.1.4 + @leflect-java/core@0.1.4",
      summaryCounts:
        summary.counts && typeof summary.counts === "object"
          ? (summary.counts as LeflectSummaryCounts)
          : {},
      labels:
        summary.labels && typeof summary.labels === "object"
          ? (summary.labels as Record<string, unknown>)
          : {},
      stageReport: analyzeResult.stages.map((stage) => ({
        stage: stage.stage,
        status: stage.status,
        ...optionalNumberField("processedFiles", stage.processedFiles),
        ...optionalNumberField("totalFiles", stage.totalFiles),
      })),
      jspImpacts: Array.isArray(summary.jspImpacts)
        ? (summary.jspImpacts as Record<string, unknown>[]).map((entry) => ({
            jspPath: String(entry.jspPath ?? ""),
            labels: Array.isArray(entry.labels)
              ? entry.labels.map((value) => String(value))
              : [],
            javaTargets: Array.isArray(entry.javaTargets)
              ? entry.javaTargets.map((value) => String(value))
              : [],
            unresolvedTargets: Array.isArray(entry.unresolvedTargets)
              ? entry.unresolvedTargets.map((value) => String(value))
              : [],
          }))
        : [],
      unresolvedDiagnostics: Array.isArray(unresolved.diagnostics)
        ? (unresolved.diagnostics as Record<string, unknown>[])
            .map((entry) => ({
              ...optionalStringField("stage", entry.stage),
              ...optionalStringField("severity", entry.severity),
              ...optionalStringField("path", entry.path),
              ...optionalStringField("summary", entry.summary),
              ...optionalStringField("message", entry.message),
            }))
            .slice(0, 50)
        : [],
      javaFiles,
      jspFiles,
    };
  } finally {
    await rm(tempParent, { recursive: true, force: true });
  }
}
