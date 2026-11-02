import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { createOutputDirName, serializeRecords, writeJson } from "./sample-files.js";
import {
  resolveRendererOptions,
  resolveRequestHeaders,
  withDebugStream,
} from "./sample-runtime.js";

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
  type KnowledgeMemory,
  type MemoryRecord,
  type MemoryRecordInput,
  type SystemMemory,
  type UserMemory,
  type WorkflowMemory,
} from "agentic-task-kit";

import { JavaJspModernizationWorkflow } from "./java-jsp-modernization-workflow.js";

const DAY_MS = 24 * 60 * 60 * 1000;

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
          "prefer structured Leflect snapshots over raw source prompts",
        ],
        behaviorPatterns: [
          "checks validation output before requirements extraction and design",
          "keeps request attribute names and status literals stable across rewrites",
        ],
        lastUpdated: now,
      } satisfies UserMemory,
      description: "Operator preference memory for sample-project Java/JSP modernization example",
      keywords: ["user", "modernization", "java", "jsp", "sample-project"],
      importance: 0.92,
      phase: "PLANNING",
      taskType: "user",
      sourceTask: "seed.user",
    },
    {
      id: "memory.system.summary.sample-project.java-jsp.policy",
      shard: "system",
      kind: "summary",
      payload: {
        policies: [
          "Always analyze Java and JSP through Leflect structured outputs before prompting the model",
          "Always preserve public method signatures, request attribute names, and status literals unless validation explicitly allows change",
        ],
        constraints: [
          "Do not inject raw Java or JSP files directly into prompts",
          "Write generated files under the reimplementation output root",
        ],
      } satisfies SystemMemory,
      description: "System guardrails for sample-project Java/JSP modernization example",
      keywords: ["system", "policy", "leflect", "sample-project", "modernization"],
      importance: 0.96,
      phase: "PLANNING",
      taskType: "workflow",
      sourceTask: "seed.system",
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
          "This sample proves the local file dependency sample-project can orchestrate a Java/JSP modernization workflow backed by Leflect and Gemini.",
      } satisfies WorkflowMemory,
      description: "Initial workflow summary for sample-project Java/JSP modernization example",
      keywords: ["workflow", "sample-project", "java", "jsp", "gemini"],
      importance: 0.9,
      phase: "PLANNING",
      taskType: "workflow",
      sourceTask: "seed.workflow",
    },
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
  configPath,
});

if (!providerOptions.apiKey) {
  process.stdout.write(
    `Gemini API key is not configured. Set GEMINI_API_KEY or put apiKey in ${configPath}.\n`,
  );
  process.exit(0);
}

const requestedWorkspaceRoot = process.argv[2]
  ? resolve(process.cwd(), process.argv[2])
  : defaultWorkspaceRoot;
const outputDir = resolve(
  projectRoot,
  "generated",
  createOutputDirName(requestedWorkspaceRoot, { unique: true, fallback: "legacy-workspace" }),
);
await mkdir(outputDir, { recursive: true });

const rendererOptions = resolveRendererOptions();
const debugLogStream = rendererOptions.mode === "ink" ? new PassThrough() : undefined;
const renderer = createCLIRenderer({
  ...rendererOptions,
  ...(debugLogStream ? { debugLogStream } : {}),
});

const kvStore = new InMemoryKVStore();
const vectorStore = new InMemoryVectorStore();
const graphStore = new InMemoryGraphStore();
const embeddingProvider = new DeterministicHashEmbeddingProvider();
const memoryEngine = new InMemoryMemoryEngine({
  kvStore,
  vectorStore,
  graphStore,
  embeddingProvider,
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
    tags: ["knowledge", "stale", "archive", "modernization", "sample-project"],
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
  sourceTask: "seed.stale-knowledge",
};
await kvStore.put(staleKnowledgeRecord);
await vectorStore.upsert({
  id: staleKnowledgeRecord.id,
  embedding: staleEmbedding.embedding,
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
  })(),
});

cycle.register("sample-project-java-jsp", JavaJspModernizationWorkflow);

const { frame } = await cycle.run(
  "sample-project-java-jsp",
  createWorkflowInputMap({
    workspaceRoot: requestedWorkspaceRoot,
    outputDir,
    requestHeaders: resolveRequestHeaders(),
    forceValidationFail: process.env.SAMPLE_FORCE_VALIDATION_FAIL === "1",
  }),
  {
    memoryInjection: createMemoryInjection(now),
    rag: [
      {
        id: "sample-project-java-jsp-rag-contracts",
        text: "RAG note: preserve request attribute names, status literals, and externally visible controller method signatures across reimplementation.",
      },
      {
        id: "sample-project-java-jsp-rag-renderer",
        text: "RAG note: line mode is append-only, while ink mode renders workflow history and debug logs in a two-column TUI when a TTY is available.",
      },
    ],
  },
);

await writeJson(resolve(outputDir, "90-memory-snapshot.json"), {
  active: serializeRecords(await memoryEngine.list({ archived: false })),
  archived: serializeRecords(await memoryEngine.list({ archived: true })),
});
await writeJson(resolve(outputDir, "91-run-frame.json"), frame);

process.stdout.write(
  `Sample project Java/JSP modernization finished with status=${frame.status} completedTasks=${frame.completedTasks.join(",")} failedTasks=${frame.failedTasks.join(",")} outputDir=${outputDir}\n`,
);
