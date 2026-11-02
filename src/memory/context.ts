import type {
  BeforeStepInput,
  MemoryPhase,
  MemoryRecord,
  MemoryShard,
  MemoryTaskType,
  RetrieveHit,
} from "../types.js";
import { safeJson } from "./text.js";

export function buildStepQuery(input: BeforeStepInput): string {
  return [input.currentStep, input.taskName, input.taskType, input.phase, safeJson(input.input)]
    .filter(Boolean)
    .join(" ");
}

export function routeMemory(taskType: MemoryTaskType): MemoryShard[] {
  switch (taskType) {
    case "user":
      return ["user"];
    case "workflow":
      return ["workflow", "task"];
    case "debug":
      return ["task", "knowledge"];
    default:
      return ["knowledge"];
  }
}

export function assembleContext(args: {
  hits: RetrieveHit[];
  phase: MemoryPhase;
  maxTokens: number;
}): { assembledContext: string; usedTokens: number } {
  const lines = [`Phase: ${args.phase}`];
  let usedTokens = estimateTokens(lines.join("\n"));

  const shardPriority = phasePriority(args.phase);
  const ordered = [...args.hits].sort((left, right) => {
    const shardDelta =
      shardPriority.indexOf(left.record.shard) - shardPriority.indexOf(right.record.shard);
    if (shardDelta !== 0) {
      return shardDelta;
    }

    if (left.record.kind !== right.record.kind) {
      return left.record.kind === "summary" ? -1 : 1;
    }

    return right.finalScore - left.finalScore;
  });

  for (const hit of ordered) {
    const line = `[${hit.record.shard}/${hit.record.kind}] ${hit.record.description}: ${truncateForContext(hit.record.payload)}`;
    const cost = estimateTokens(line);
    if (usedTokens + cost > args.maxTokens) {
      break;
    }

    lines.push(line);
    usedTokens += cost;
  }

  return {
    assembledContext: lines.join("\n"),
    usedTokens,
  };
}

function phasePriority(phase: MemoryPhase): MemoryShard[] {
  switch (phase) {
    case "PLANNING":
      return ["system", "knowledge", "workflow", "user", "task"];
    case "EXECUTION":
      return ["task", "workflow", "system", "user", "knowledge"];
    case "REFLECTION":
      return ["workflow", "task", "user", "knowledge", "system"];
    case "RECOVERY":
      return ["task", "system", "workflow", "knowledge", "user"];
  }
}

function estimateTokens(value: string): number {
  return Math.ceil(value.length / 4);
}

function truncateForContext(payload: MemoryRecord["payload"]): string {
  const text = safeJson(payload);
  if (text.length <= 240) {
    return text;
  }

  return `${text.slice(0, 237)}...`;
}
