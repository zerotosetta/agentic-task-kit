import type { MemoryRecord, MemoryRecordInput } from "../types.js";
import { safeJson, stringifyPayload } from "./text.js";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function normalizeQuery(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function tokenize(value: string): string[] {
  return normalizeQuery(value)
    .split(/[^a-z0-9_]+/iu)
    .map((token) => token.trim())
    .filter(Boolean);
}

export function computeKeywordScore(record: MemoryRecord, normalizedQuery: string): number {
  const queryTokens = tokenize(normalizedQuery);
  if (queryTokens.length === 0) {
    return 0;
  }

  const haystack = normalizeQuery(
    `${record.description} ${record.keywords.join(" ")} ${safeJson(record.payload)}`,
  );
  const matches = queryTokens.filter((token) => haystack.includes(token)).length;
  return matches / queryTokens.length;
}

export function computeRecencyScore(record: MemoryRecord): number {
  const age = Date.now() - record.lastAccessedAt;
  return clamp01(1 - age / (30 * DAY_MS));
}

export function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }

  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }

  return clamp01(dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude)));
}

export function calculateImportance(record: MemoryRecordInput, novelty: number): number {
  const relevance = calculateRelevance(record);
  const reuseProbability = calculateReuseProbability(record);
  const impact = calculateImpact(record);
  return (relevance + reuseProbability + impact + novelty) / 4;
}

function calculateRelevance(record: MemoryRecordInput): number {
  if (record.shard === "system" || record.shard === "knowledge") {
    return 0.9;
  }

  if (record.shard === "workflow" || record.kind === "summary") {
    return 0.8;
  }

  if (record.shard === "task") {
    return 0.7;
  }

  return 0.6;
}

function calculateReuseProbability(record: MemoryRecordInput): number {
  switch (record.shard) {
    case "knowledge":
      return 0.9;
    case "user":
    case "system":
      return 0.8;
    case "workflow":
      return 0.7;
    case "task":
      return 0.6;
  }
}

function calculateImpact(record: MemoryRecordInput): number {
  const serialized = `${record.description} ${safeJson(record.payload)}`.toLowerCase();
  if (serialized.includes("error") || serialized.includes("failed")) {
    return 1;
  }

  if (record.kind === "summary") {
    return 0.8;
  }

  if (record.shard === "workflow" || record.shard === "knowledge") {
    return 0.75;
  }

  return 0.6;
}

export function findSimilarityMatch(
  record: MemoryRecordInput,
  candidates: MemoryRecord[],
  normalizedContent: string,
): { record: MemoryRecord; score: number } | null {
  let best: { record: MemoryRecord; score: number } | null = null;
  for (const candidate of candidates) {
    if (record.id && candidate.id === record.id) {
      continue;
    }

    const score = keywordSimilarity(
      normalizedContent,
      stringifyPayload(candidate.payload, candidate.description),
    );
    if (!best || score > best.score) {
      best = {
        record: candidate,
        score,
      };
    }
  }

  return best;
}

function keywordSimilarity(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }

  return intersection / Math.max(leftTokens.size, rightTokens.size);
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
