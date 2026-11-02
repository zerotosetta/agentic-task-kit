import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

type OutputDirectoryOptions = { fallback?: string; unique?: boolean; stripJavaExtension?: boolean };

export function resolveOutputPath(outputDir: string, fileName: string): string {
  if (typeof fileName !== "string" || !fileName.trim())
    throw new TypeError("Generated file path must be a non-empty relative path.");
  const normalized = fileName.replaceAll("\\", "/");
  if (normalized.startsWith("/") || /^[a-z]:/iu.test(normalized))
    throw new Error("Generated file path must be relative to the output directory.");
  const target = resolve(outputDir, normalized);
  const within = relative(resolve(outputDir), target);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error("Generated file path escapes the output directory.");
  return target;
}

export function createOutputDirName(
  inputPath: string,
  options: OutputDirectoryOptions = {},
): string {
  const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
  const fileName = basename(inputPath);
  const prefix =
    (options.stripJavaExtension ? fileName.replace(/\.java$/iu, "") : fileName) ||
    options.fallback ||
    "workspace";
  const suffix = options.unique ? `-${process.pid}-${randomBytes(2).toString("hex")}` : "";
  return `${prefix}-${timestamp}${suffix}`;
}

const RECORD_FIELDS = [
  "id",
  "shard",
  "kind",
  "description",
  "keywords",
  "importance",
  "createdAt",
  "updatedAt",
  "lastAccessedAt",
  "archivedAt",
  "workflowId",
  "runId",
  "sourceTask",
  "phase",
  "taskType",
  "payload",
] as const;
const NULLABLE_FIELDS = new Set<string>([
  "archivedAt",
  "workflowId",
  "runId",
  "sourceTask",
  "phase",
  "taskType",
]);

export function serializeRecord(record: object): Record<string, unknown> {
  const source = record as Record<string, unknown>;
  return Object.fromEntries(
    RECORD_FIELDS.map((field) => [
      field,
      NULLABLE_FIELDS.has(field) ? (source[field] ?? null) : source[field],
    ]),
  );
}

export function serializeRecords(records: readonly object[]): Array<Record<string, unknown>> {
  return records.map(serializeRecord);
}

export async function writeJson(file: string, value: unknown): Promise<void> {
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export async function writeJsonArtifact(
  outputDir: string,
  fileName: string,
  value: unknown,
): Promise<void> {
  await writeJson(resolve(outputDir, fileName), value);
}
