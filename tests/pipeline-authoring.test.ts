import { describe, expect, it } from "vitest";
import { defineOperation, defineStep } from "../src/pipeline-authoring.js";
import { assertPipelineSchema, assertPipelineValue } from "../src/pipeline-schema.js";

describe("pipeline schema contracts", () => {
  it("infers required, optional and item types in TypeScript handlers", () => {
    const input = {
      type: "object", properties: { values: { type: "array", items: { type: "number" } }, label: { type: "string" } },
      required: ["values"], additionalProperties: false,
    } as const;
    const schema = { type: "integer" } as const;
    const count = defineStep({ key: "count", inputSchema: input, outputSchema: schema,
      run: ({values, label}) => values.length + (label?.length ?? 0) });
    const operation = defineOperation({ key: "count", description: "Count numeric items", revision: "1", effect: "read",
      inputSchema: input, outputSchema: schema, run: ({values}) => values.length });
    expect([count.key, operation.key]).toEqual(["count", "count"]);
    // @ts-expect-error The handler must produce the output declared by the schema.
    defineStep({ key: "invalid", inputSchema: input, outputSchema: schema, run: () => "one" });
  });

  it("validates nested values, rejects unsupported schema keywords and counts only own properties", () => {
    expect(() => assertPipelineSchema({ type: "string", pattern: ".*" })).toThrow(/keyword/);
    expect(() => assertPipelineSchema({ type: "number", enum: [1, 1] })).toThrow(/duplicate/);
    const input = {
      type: "object", properties: { values: { type: "array", items: { type: "integer", enum: [1, 2] } } },
      required: ["values"], additionalProperties: false,
    } as const;
    expect(() => assertPipelineValue(input, {values: [2, 1]})).not.toThrow();
    expect(() => assertPipelineValue(input, {values: [3]})).toThrow(/enum/);
    expect(() => assertPipelineValue(input, JSON.parse('{"values":[],"__proto__":1}'))).toThrow(/unexpected/);
    expect(() => assertPipelineValue({type:"object", required:["toString"]}, {})).toThrow(/requires/);
  });
});
