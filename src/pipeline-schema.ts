import { isDeepStrictEqual } from "node:util";
import { copyJSON, isRecord } from "./durable-validation.js";
import type { DurableJSON } from "./types/durable.js";

/** The JSON Schema vocabulary shared by discovery, planning and runtime validation. */
export type PipelineSchema = {
  readonly type: "object" | "array" | "string" | "integer" | "number" | "boolean" | "null";
  readonly description?: string;
  readonly properties?: Readonly<Record<string, PipelineSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: PipelineSchema;
  readonly enum?: readonly DurableJSON[];
};

const types = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);
const common = ["type", "description", "enum"];
const objectKeys = [...common, "properties", "required", "additionalProperties"];

function invalid(message: string): never {
  throw new TypeError(message);
}

export function assertPipelineSchema(schema: unknown, label = "schema"): asserts schema is PipelineSchema {
  function visit(node: unknown, path: string, depth: number) {
    if (depth > 64) invalid(path + " exceeds the maximum schema depth.");
    if (!isRecord(node) || typeof node.type !== "string" || !types.has(node.type)) invalid(path + " requires a supported type.");
    const keys = node.type === "object" ? objectKeys : node.type === "array" ? [...common, "items"] : common;
    for (const key of Object.keys(node)) {
      if (!keys.includes(key)) invalid(path + " has unsupported keyword " + key + ".");
    }
    if ("description" in node && typeof node.description !== "string") invalid(path + ".description must be text.");
    if ("properties" in node) {
      if (!isRecord(node.properties)) invalid(path + ".properties must be an object.");
      for (const [key, child] of Object.entries(node.properties)) visit(child, path + ".properties." + key, depth + 1);
    }
    if ("additionalProperties" in node && typeof node.additionalProperties !== "boolean") invalid(path + ".additionalProperties must be boolean.");
    if ("required" in node) {
      if (!Array.isArray(node.required) || !node.required.every(key => typeof key === "string") ||
          new Set(node.required).size !== node.required.length) invalid(path + ".required must list distinct property names.");
      if (node.additionalProperties === false && node.required.some(key => !Object.hasOwn(node.properties ?? {}, key))) {
        invalid(path + " requires an undeclared property in a closed object.");
      }
    }
    if ("items" in node) visit(node.items, path + ".items", depth + 1);
    if ("enum" in node) {
      if (!Array.isArray(node.enum) || node.enum.length === 0) invalid(path + ".enum must be a nonempty array.");
      const values = copyJSON(node.enum, null, path + ".enum", "INVALID_INPUT") as readonly DurableJSON[];
      if (values.some((value, i) => values.slice(0, i).some(other => isDeepStrictEqual(value, other)))) invalid(path + ".enum has duplicate values.");
    }
  }
  visit(schema, label, 0);
}

function check(schema: PipelineSchema, value: DurableJSON, path: string): void {
  if (schema.enum && !schema.enum.some(item => isDeepStrictEqual(item, value))) invalid(path + " is outside the declared enum.");
  if (schema.type === "object" && isRecord(value)) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) invalid(path + " requires property " + key + ".");
    const properties = schema.properties ?? {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) check(properties[key]!, item as DurableJSON, path + "." + key);
      else if (schema.additionalProperties === false) invalid(path + " has unexpected property " + key + ".");
    }
    return;
  }
  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.items) value.forEach((item, index) => check(schema.items!, item, path + "[" + index + "]"));
    return;
  }
  if (schema.type === "null" && value === null) return;
  if (schema.type === "integer" && typeof value === "number" && Number.isInteger(value)) return;
  if ((schema.type === "number" || schema.type === "string" || schema.type === "boolean") && typeof value === schema.type) return;
  invalid(path + " must have type " + schema.type + ".");
}

export function assertPipelineValue(schema: PipelineSchema, value: unknown, label = "value"): asserts value is DurableJSON {
  assertPipelineSchema(schema);
  check(schema, copyJSON(value, null, label, "INVALID_INPUT"), label);
}
