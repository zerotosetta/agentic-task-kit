import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { copyJSON, hasText, isRecord, sha256 } from "../durable-validation.js";
import type { DurableJSON } from "../types/durable.js";
import type { McpWorkflowProfile } from "../types/mcp.js";
import { assertPipelineSchema } from "../pipeline-schema.js";
import type { PipelineOperationDescriptor } from "../pipeline-planner.js";

export class McpWorkflowError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "McpWorkflowError";
  }
}

export interface McpConfig {
  configPath: string;
  stateDirectory: string;
  jobDatabase: string;
  executionDatabase: string;
  profiles: ReadonlyMap<string, McpWorkflowProfile>;
  leaseMs: number;
  queueMs: number;
}

function duration(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 100 || value > 2_147_483_647) {
    throw new McpWorkflowError("INVALID_CONFIG", field + " must be a whole number of milliseconds from 100 to 2147483647.");
  }
  return value;
}

export function parseStageOrder(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 256 ||
      !value.every((key: unknown) => hasText(key) && key.length <= 256) || new Set(value).size !== value.length) {
    throw new McpWorkflowError("INVALID_CONFIG", "Profile stageOrder must contain 1 to 256 unique, nonblank step keys of at most 256 characters each.");
  }
  return Object.freeze(value);
}

function parseOperations(value: unknown): PipelineOperationDescriptor[] {
  if (!Array.isArray(value)) throw new McpWorkflowError("INVALID_CONFIG", "Profile operations must be an array.");
  const keys = new Set<string>();
  return value.map(operation => {
    if (!isRecord(operation) || !hasText(operation.key) || keys.has(operation.key) ||
        !hasText(operation.description) || !hasText(operation.revision) ||
        (operation.effect !== "read" && operation.effect !== "write" && operation.effect !== "external")) {
      throw new McpWorkflowError("INVALID_CONFIG", "Each operation requires a distinct key, description, revision and effect.");
    }
    keys.add(operation.key);
    assertPipelineSchema(operation.inputSchema, operation.key + ".inputSchema");
    assertPipelineSchema(operation.outputSchema, operation.key + ".outputSchema");
    if (operation.inputSchema.type !== "object") throw new TypeError("Operation arguments require an object schema.");
    const { key, revision, description, effect, inputSchema, outputSchema } = operation;
    return { key, revision, description, effect, inputSchema, outputSchema };
  });
}

export function loadMcpConfig(configPath: string, options: { allowEmptyProfiles?: boolean; stateDirectory?: string } = {}): McpConfig {
  configPath = resolve(configPath);
  const config: unknown = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/u, ""));
  if (!isRecord(config) || !hasText(config.stateDirectory) || !isRecord(config.profiles)) {
    throw new McpWorkflowError("INVALID_CONFIG", "The configuration requires stateDirectory and profiles.");
  }
  const base = dirname(configPath);
  const stateDirectory = options.stateDirectory === undefined ? resolve(base, config.stateDirectory) : resolve(options.stateDirectory);
  const profiles = new Map<string, McpWorkflowProfile>();
  for (const [name, value] of Object.entries(config.profiles)) {
    if (name.length > 128) throw new McpWorkflowError("INVALID_CONFIG", "Profile names support up to 128 characters.");
    if (!hasText(name) || !isRecord(value) || !hasText(value.module) || !hasText(value.revision)) {
      throw new McpWorkflowError("INVALID_CONFIG", "Each profile requires a module file and revision.");
    }
    const maxSteps = value.maxSteps;
    if (maxSteps !== undefined && (typeof maxSteps !== "number" || !Number.isSafeInteger(maxSteps) || maxSteps < 1)) {
      throw new McpWorkflowError("INVALID_CONFIG", "Profile maxSteps must be a positive safe integer.");
    }
    if (value.description !== undefined && typeof value.description !== "string") {
      throw new McpWorkflowError("INVALID_CONFIG", "Profile description must be text.");
    }
    const { inputSchema, outputSchema } = value;
    let operations: PipelineOperationDescriptor[] | undefined;
    try {
      if (value.operations !== undefined) operations = parseOperations(value.operations);
      if (inputSchema !== undefined) {
        assertPipelineSchema(inputSchema, name + ".inputSchema");
        if (inputSchema.type !== "object") throw new TypeError("Workflow requests require an object schema.");
      }
      if (outputSchema !== undefined) assertPipelineSchema(outputSchema, name + ".outputSchema");
    } catch (error) {
      throw new McpWorkflowError("INVALID_CONFIG", error instanceof Error ? error.message : "Invalid profile schema.");
    }
    profiles.set(name, {
      name,
      module: resolve(base, value.module),
      revision: value.revision,
      ...(value.description === undefined ? {} : { description: value.description }),
      ...(inputSchema === undefined ? {} : { inputSchema }),
      ...(outputSchema === undefined ? {} : { outputSchema }),
      ...(operations === undefined ? {} : { operations }),
      settings: value.settings === undefined ? {} : copyJSON(value.settings, null, "Profile settings", "INVALID_INPUT"),
      ...(maxSteps === undefined ? {} : { maxSteps }),
      ...(value.stageOrder === undefined ? {} : { stageOrder: parseStageOrder(value.stageOrder) }),
    });
  }
  if (!profiles.size && !options.allowEmptyProfiles) throw new McpWorkflowError("INVALID_CONFIG", "Register at least one workflow profile.");
  const leaseMs = duration(config.leaseMs, 30_000, "leaseMs");
  return {
    configPath,
    stateDirectory,
    jobDatabase: join(stateDirectory, "jobs.sqlite"),
    executionDatabase: join(stateDirectory, "execution.sqlite"),
    profiles,
    leaseMs,
    queueMs: duration(config.queueMs, Math.max(10_000, leaseMs), "queueMs"),
  };
}

export function jsonFingerprint(value: DurableJSON): string {
  return sha256(Buffer.from(JSON.stringify(value, (_key, entry: unknown) =>
    isRecord(entry) ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry,
  )));
}

export function profileFingerprint(profile: McpWorkflowProfile): string {
  return jsonFingerprint([
    profile.name,
    profile.module,
    profile.revision,
    profile.settings,
    profile.maxSteps ?? null,
    sha256(readFileSync(profile.module)),
    ...(profile.inputSchema || profile.outputSchema ? [profile.inputSchema ?? null, profile.outputSchema ?? null] : []),
  ]);
}
