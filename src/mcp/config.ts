import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { copyJSON, hasText, isRecord, sha256 } from "../durable-validation.js";
import type { DurableJSON } from "../types/durable.js";
import type { McpWorkflowProfile } from "../types/mcp.js";

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

export function loadMcpConfig(configPath: string): McpConfig {
  configPath = resolve(configPath);
  const config: unknown = JSON.parse(readFileSync(configPath, "utf8").replace(/^\uFEFF/u, ""));
  if (!isRecord(config) || !hasText(config.stateDirectory) || !isRecord(config.profiles)) {
    throw new McpWorkflowError("INVALID_CONFIG", "The configuration requires stateDirectory and profiles.");
  }
  const base = dirname(configPath);
  const stateDirectory = resolve(base, config.stateDirectory);
  const profiles = new Map<string, McpWorkflowProfile>();
  for (const [name, value] of Object.entries(config.profiles)) {
    if (!hasText(name) || !isRecord(value) || !hasText(value.module) || !hasText(value.revision)) {
      throw new McpWorkflowError("INVALID_CONFIG", "Each profile requires a module file and revision.");
    }
    const maxSteps = value.maxSteps;
    if (maxSteps !== undefined && (typeof maxSteps !== "number" || !Number.isSafeInteger(maxSteps) || maxSteps < 1)) {
      throw new McpWorkflowError("INVALID_CONFIG", "Profile maxSteps must be a positive safe integer.");
    }
    profiles.set(name, {
      name,
      module: resolve(base, value.module),
      revision: value.revision,
      settings: value.settings === undefined ? {} : copyJSON(value.settings, null, "Profile settings", "INVALID_INPUT"),
      ...(maxSteps === undefined ? {} : { maxSteps }),
    });
  }
  if (!profiles.size) throw new McpWorkflowError("INVALID_CONFIG", "Register at least one workflow profile.");
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
  ]);
}
