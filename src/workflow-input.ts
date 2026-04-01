import type { WorkflowInput } from "./types.js";

export type WorkflowInputInit =
  | WorkflowInput
  | Record<string, any>
  | Iterable<readonly [string, any]>
  | undefined;

export function createWorkflowInput(init?: WorkflowInputInit): WorkflowInput {
  if (!init) {
    return new Map<string, any>();
  }

  if (init instanceof Map) {
    return new Map<string, any>(init);
  }

  if (Symbol.iterator in Object(init) && !isPlainObject(init)) {
    return new Map<string, any>(init as Iterable<readonly [string, any]>);
  }

  return new Map<string, any>(Object.entries(init));
}

export function workflowInputToObject(input: WorkflowInput): Record<string, any> {
  return Object.fromEntries(input);
}

export function getWorkflowInputValue<T = any>(
  input: WorkflowInput,
  key: string,
): T | undefined {
  return input.get(key) as T | undefined;
}

export function requireWorkflowInputValue<T = any>(
  input: WorkflowInput,
  key: string,
): T {
  if (!input.has(key)) {
    throw new Error(`Workflow input is missing "${key}".`);
  }

  return input.get(key) as T;
}

export function workflowInputToPrettyJson(input: WorkflowInput): string {
  return JSON.stringify(toSerializableValue(input), null, 2);
}

export function toSerializableValue(value: unknown): unknown {
  return serializeValue(value, new WeakSet<object>());
}

function serializeValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([key, entryValue]) => [
        String(key),
        serializeValue(entryValue, seen)
      ]),
    );
  }

  if (value instanceof Set) {
    return [...value.values()].map((entry) => serializeValue(entry, seen));
  }

  if (Array.isArray(value)) {
    return value.map((entry) => serializeValue(entry, seen));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.stack ? { stack: value.stack } : {})
    };
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[Circular]";
  }

  seen.add(value);
  const serialized = Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      serializeValue(entryValue, seen)
    ]),
  );
  seen.delete(value);
  return serialized;
}

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
