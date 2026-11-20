import { serveMcpTools } from "agentic-task-kit";
import { textSchema, countSchema } from "./operations.mjs";

await serveMcpTools([{
  name: "count_words", description: "Count whitespace-separated words.",
  inputSchema: textSchema, outputSchema: countSchema,
  run: ({ text }) => ({ count: text.trim() ? text.trim().split(/\s+/u).length : 0 }),
}], { name: "words", version: "1" });
