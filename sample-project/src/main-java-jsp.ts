import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  DeterministicHashEmbeddingProvider,
  InMemoryGraphStore,
  InMemoryKVStore,
  InMemoryMemoryEngine,
  InMemoryVectorStore,
  createCLIRenderer,
  createCycle,
  createOpenAICompatibleChatProvider,
  loadOpenAICompatibleChatProviderOptionsFromConfigFile,
  resolveOpenAICompatibleChatConfigPath,
  type CLIRendererOptions,
  type KnowledgeMemory,
  type MemoryRecord,
  type MemoryRecordInput,
  type SystemMemory,
  type UserMemory,
  type WorkflowMemory
} from "agentic-task-kit";

import { JavaJspModernizationWorkflow } from "./java-jsp-modernization-workflow.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function resolveRendererOptions(): CLIRendererOptions {
  const requestedMode = process.env.CYCLE_RENDER_MODE as CLIRendererOptions["mode"];
  const requestedLogLevel = process.env.CYCLE_LOG_LEVEL as CLIRendererOptions["logLevel"];

  if (requestedMode) {
    return {
      enabled: process.env.CYCLE_LIVE !== "0",
      mode: requestedMode,
      ...(requestedLogLevel ? { logLevel: requestedLogLevel } : {})
    };
  }

  return {
    enabled: process.env.CYCLE_LIVE !== "0",
    ...(requestedLogLevel ? { logLevel: requestedLogLevel } : {})
  };
}

function resolveHTTPDebugEnabled(
  value: boolean | Record<string, unknown> | undefined
): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const enabled = value["enabled"];
    return typeof enabled === "boolean" ? enabled : true;
  }

  return ["1", "true", "yes", "on"].includes((process.env.OPENAI_HTTP_DEBUG ?? "").toLowerCase());
}

function withDebugStream<T extends { httpDebugLogging?: boolean | Record<string, unknown> }>(
  options: T,
  debugLogStream: PassThrough | undefined
): T {
  if (!debugLogStream || !resolveHTTPDebugEnabled(options.httpDebugLogging)) {
    return options;
  }

  const current = options.httpDebugLogging;
  return {
    ...options,
    httpDebugLogging:
      current && typeof current === "object" && !Array.isArray(current)
        ? {
            ...current,
            stream: debugLogStream
          }
        : {
            enabled: true,
            stream: debugLogStream
          }
  };
}

function resolveRequestHeaders(): Record<string, string> | undefined {
  if (!process.env.CYCLE_REQUEST_HEADERS_JSON) {
    return undefined;
  }

  const parsed = JSON.parse(process.env.CYCLE_REQUEST_HEADERS_JSON) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("CYCLE_REQUEST_HEADERS_JSON must be a JSON object.");
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") {
      headers[key] = value;
    }
  }

  return Object.keys(headers).length > 0 ? headers : undefined;
}

function createOutputDirName(inputPath: string): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const fileName = inputPath.split("/").at(-1) ?? "legacy-workspace";
  const uniqueness = `${process.pid}-${randomBytes(2).toString("hex")}`;
  return `${fileName}-${timestamp}-${uniqueness}`;
}

function serializeRecord(record: MemoryRecord): Record<string, unknown> {
  return {
    id: record.id,
    shard: record.shard,
    kind: record.kind,
    description: record.description,
    keywords: record.keywords,
    importance: record.importance,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastAccessedAt: record.lastAccessedAt,
    archivedAt: record.archivedAt ?? null,
    workflowId: record.workflowId ?? null,
    runId: record.runId ?? null,
    sourceTask: record.sourceTask ?? null,
    phase: record.phase ?? null,
    taskType: record.taskType ?? null,
    payload: record.payload
  };
}

function serializeRecords(records: MemoryRecord[]): Array<Record<string, unknown>> {
  return records.map((record) => serializeRecord(record));
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createMemoryInjection(now: number): MemoryRecordInput[] {
  return [
    {
      id: "memory.user.summary.sample-project.java-jsp.modernizer",
      shard: "user",
      kind: "summary",
      payload: {
        userId: "sample-project-modernizer",
        preferences: [
          "preserve Java and JSP observable contracts",
          "prefer structured Leflect snapshots over raw source prompts"
        ],
        behaviorPatterns: [
          "checks validation output before requirements extraction and design",
          "keeps request attribute names and status literals stable across rewrites"
        ],
        lastUpdated: now
      } satisfies UserMemory,
      description: "Operator preference memory for sample-project Java/JSP modernization example",
      keywords: ["user", "modernization", "java", "jsp", "sample-project"],
      importance: 0.92,
      phase: "PLANNING",
      taskType: "user",
      sourceTask: "seed.user"
    },
    {
      id: "memory.system.summary.sample-project.java-jsp.policy",
      shard: "system",
      kind: "summary",
      payload: {
        policies: [
          "Always analyze Java and JSP through Leflect structured outputs before prompting the model",
          "Always preserve public method signatures, request attribute names, and status literals unless validation explicitly allows change"
        ],
        constraints: [
          "Do not inject raw Java or JSP files directly into prompts",
          "Write generated files under the reimplementation output root"
        ]
      } satisfies SystemMemory,
      description: "System guardrails for sample-project Java/JSP modernization example",
      keywords: ["system", "policy", "leflect", "sample-project", "modernization"],
      importance: 0.96,
      phase: "PLANNING",
      taskType: "workflow",
      sourceTask: "seed.system"
    },
    {
      id: "memory.workflow.summary.sample-project.java-jsp.seed",
      shard: "workflow",
      kind: "summary",
      payload: {
        workflowId: "sample-project-java-jsp-modernization",
        currentStep: "seed",
        history: [],
        contextSummary:
          "This sample proves the local file dependency sample-project can orchestrate a Java/JSP modernization workflow backed by Leflect and Gemini."
      } satisfies WorkflowMemory,
      description: "Initial workflow summary for sample-project Java/JSP modernization example",
      keywords: ["workflow", "sample-project", "java", "jsp", "gemini"],
      importance: 0.9,
      phase: "PLANNING",
      taskType: "workflow",
      sourceTask: "seed.workflow"
    }
  ];
}

function createWorkflowInputMap(source: Record<string, unknown>): Map<string, any> {
  return new Map<string, any>(Object.entries(source));
}

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const projectRoot = resolve(currentDir, "..");
const defaultConfigPath = existsSync(resolve(projectRoot, "cycle.java-jsp.local.json"))
  ? resolve(projectRoot, "cycle.java-jsp.local.json")
  : resolve(projectRoot, "cycle.java-jsp.config.json");
const defaultWorkspaceRoot = resolve(projectRoot, "inputs", "legacy-order-flow");
const configPath =
  resolveOpenAICompatibleChatConfigPath(process.env.CYCLE_OPENAI_COMPATIBLE_CONFIG_PATH) ??
  resolveOpenAICompatibleChatConfigPath(process.env.CYCLE_OPENAI_CONFIG_PATH) ??
  defaultConfigPath;
const providerOptions = loadOpenAICompatibleChatProviderOptionsFromConfigFile({
  configPath
});

if (!providerOptions.apiKey) {
  process.stdout.write(
    `Gemini API key is not configured. Set GEMINI_API_KEY or put apiKey in ${configPath}.\n`
  );
  process.exit(0);
}

const requestedWorkspaceRoot = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : defaultWorkspaceRoot;
const outputDir = resolve(projectRoot, "generated", createOutputDirName(requestedWorkspaceRoot));
await mkdir(outputDir, { recursive: true });

const rendererOptions = resolveRendererOptions();
const debugLogStream = rendererOptions.mode === "ink" ? new PassThrough() : undefined;
const renderer = createCLIRenderer({
  ...rendererOptions,
  ...(debugLogStream ? { debugLogStream } : {})
});

const kvStore = new InMemoryKVStore();
const vectorStore = new InMemoryVectorStore();
const graphStore = new InMemoryGraphStore();
const embeddingProvider = new DeterministicHashEmbeddingProvider();
const memoryEngine = new InMemoryMemoryEngine({
  kvStore,
  vectorStore,
  graphStore,
  embeddingProvider
});

const now = Date.now();
const staleKnowledgeContent =
  "Archived modernization note: when refactoring mixed Java/JSP legacy code, preserve request attribute names and status literals before removing scriptlets.";
const staleEmbedding = await embeddingProvider.embed(staleKnowledgeContent);
const staleKnowledgeRecord: MemoryRecord = {
  id: "memory.knowledge.raw.sample-project.java-jsp.stale-modernization-guidance",
  shard: "knowledge",
  kind: "raw",
  payload: {
    id: "sample-project-java-jsp-stale-modernization-guidance",
    content: staleKnowledgeContent,
    embedding: staleEmbedding.embedding,
    tags: ["knowledge", "stale", "archive", "modernization", "sample-project"]
  } satisfies KnowledgeMemory,
  description: "Stale modernization guidance for lifecycle archive demo",
  keywords: ["knowledge", "modernization", "archive", "stale", "sample-project"],
  importance: 0.78,
  createdAt: now - 45 * DAY_MS,
  updatedAt: now - 45 * DAY_MS,
  lastAccessedAt: now - 45 * DAY_MS,
  embedding: staleEmbedding.embedding,
  embeddingModelId: staleEmbedding.modelId,
  phase: "PLANNING",
  taskType: "default",
  sourceTask: "seed.stale-knowledge"
};
await kvStore.put(staleKnowledgeRecord);
await vectorStore.upsert({
  id: staleKnowledgeRecord.id,
  embedding: staleEmbedding.embedding
});

const cycle = createCycle({
  aiProvider: createOpenAICompatibleChatProvider(withDebugStream(providerOptions, debugLogStream)),
  memoryEngine,
  observers: [renderer],
  now: (() => {
    let current = now;
    return () => {
      current += 1_000;
      return current;
    };
  })()
});

cycle.register("sample-project-java-jsp", JavaJspModernizationWorkflow);

const { frame } = await cycle.run(
  "sample-project-java-jsp",
  createWorkflowInputMap({
    workspaceRoot: requestedWorkspaceRoot,
    outputDir,
    requestHeaders: resolveRequestHeaders(),
    forceValidationFail: process.env.SAMPLE_FORCE_VALIDATION_FAIL === "1"
  }),
  {
    memoryInjection: createMemoryInjection(now),
    rag: [
      {
        id: "sample-project-java-jsp-rag-contracts",
        text: "RAG note: preserve request attribute names, status literals, and externally visible controller method signatures across reimplementation."
      },
      {
        id: "sample-project-java-jsp-rag-renderer",
        text: "RAG note: line mode is append-only, while ink mode renders workflow history and debug logs in a two-column TUI when a TTY is available."
      }
    ]
  }
);

await writeJson(resolve(outputDir, "90-memory-snapshot.json"), {
  active: serializeRecords(await memoryEngine.list({ archived: false })),
  archived: serializeRecords(await memoryEngine.list({ archived: true }))
});
await writeJson(resolve(outputDir, "91-run-frame.json"), frame);

process.stdout.write(
  `Sample project Java/JSP modernization finished with status=${frame.status} completedTasks=${frame.completedTasks.join(",")} failedTasks=${frame.failedTasks.join(",")} outputDir=${outputDir}\n`
);
