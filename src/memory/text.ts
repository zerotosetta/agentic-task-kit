import { createHash } from "node:crypto";
import type { MemoryRecord } from "../types.js";
import { toSerializableValue } from "../workflow-input.js";

export function stringifyPayload(payload: MemoryRecord["payload"], description: string): string {
  return `${description} ${safeJson(payload)}`;
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(toSerializableValue(value));
  } catch {
    return String(value);
  }
}

export function hashString(value: string): string {
  return createHash("sha1").update(value, "utf8").digest("hex").slice(0, 12);
}

export function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
