import { fileURLToPath } from "node:url";
import { connectMcpClient } from "agentic-task-kit";

export const objectSchema = properties => ({
  type: "object", properties, required: Object.keys(properties), additionalProperties: false,
});
export const textSchema = objectSchema({ text: { type: "string" } });
export const countSchema = objectSchema({ count: { type: "integer" } });
export const reportSchema = objectSchema({ report: { type: "string" } });

export const operations = [
  {
    key: "normalize", revision: "1", description: "Trim the input text.", effect: "read",
    inputSchema: textSchema, outputSchema: textSchema,
    run: ({ text }) => ({ text: text.trim() }),
  },
  {
    key: "count_words", revision: "1", description: "Count words using the local word service.", effect: "read",
    inputSchema: textSchema, outputSchema: countSchema,
    async run(input, ctx) {
      const client = await connectMcpClient({
        command: process.execPath, args: [fileURLToPath(new URL("./word-service.mjs", import.meta.url))],
        signal: ctx.signal,
      });
      try {
        const result = await client.callToolValue("count_words", input, { signal: ctx.signal });
        ctx.reportProgress({ operation: "count_words", completed: 1, total: 1, unit: "documents" });
        return result;
      } finally {
        await client.close();
      }
    },
  },
  {
    key: "format", revision: "1", description: "Render a count as a short report.", effect: "read",
    inputSchema: countSchema, outputSchema: reportSchema,
    run: ({ count }) => ({ report: `Words: ${count}` }),
  },
];
