import type { PipelineOperation } from "./pipeline-planner.js";
import type { PipelineSchema } from "./pipeline-schema.js";
import type { DurableJSON } from "./types/durable.js";
import type { PipelineStep, PipelineStepContext } from "./types/pipeline.js";

type RequiredKeys<S> = S extends { readonly required: readonly (infer K extends string)[] } ? K : never;
type ObjectValue<S, P extends Readonly<Record<string, PipelineSchema>>> =
  { [K in keyof P as K extends RequiredKeys<S> ? K : never]: PipelineValue<P[K]> } &
  { [K in keyof P as K extends RequiredKeys<S> ? never : K]?: PipelineValue<P[K]> };

/** Infer handler values from a literal schema (use `as const` for a separately declared schema). */
export type PipelineValue<S extends PipelineSchema> =
  S extends { readonly enum: readonly (infer E extends DurableJSON)[] } ? E :
  S extends { type: "object"; properties: infer P extends Readonly<Record<string, PipelineSchema>> } ? ObjectValue<S, P> :
  S extends { type: "object" } ? Record<string, DurableJSON> :
  S extends { type: "array"; items: infer I extends PipelineSchema } ? readonly PipelineValue<I>[] :
  S extends { type: "array" } ? readonly DurableJSON[] :
  S extends { type: "number" | "integer" } ? number :
  S extends { type: "string" } ? string :
  S extends { type: "boolean" } ? boolean :
  S extends { type: "null" } ? null : DurableJSON;

type TypedHandler<I extends PipelineSchema, O extends PipelineSchema> = {
  inputSchema: I;
  outputSchema: O;
  run: (input: PipelineValue<I>, context: PipelineStepContext) => PipelineValue<O> | Promise<PipelineValue<O>>;
};

export function defineStep<const I extends PipelineSchema, const O extends PipelineSchema>(
  step: Omit<PipelineStep, keyof TypedHandler<I, O>> & TypedHandler<I, O>,
): PipelineStep {
  // definePipeline checks the declared input immediately before calling this handler.
  return { ...step, run: (input, ctx) => step.run(input as PipelineValue<I>, ctx) as DurableJSON | Promise<DurableJSON> };
}

export function defineOperation<const I extends PipelineSchema, const O extends PipelineSchema>(
  operation: Omit<PipelineOperation, keyof TypedHandler<I, O>> & TypedHandler<I, O>,
): PipelineOperation {
  return { ...operation, run: (input, ctx) => operation.run(input as PipelineValue<I>, ctx) as DurableJSON | Promise<DurableJSON> };
}
