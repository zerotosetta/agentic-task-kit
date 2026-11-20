import { definePipeline } from "agentic-task-kit";
import { operations, textSchema, reportSchema } from "./operations.mjs";

export const pipeline = definePipeline({
  key: "word-report", revision: "1", description: "Count words in a document and return a report.",
  inputSchema: textSchema, outputSchema: reportSchema, steps: operations,
});
export const { descriptor, createWorkflow } = pipeline;
