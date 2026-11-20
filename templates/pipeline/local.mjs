import { runPipeline } from "agentic-task-kit";
import { pipeline } from "./workflow.mjs";

const text = process.argv.slice(2).join(" ") || "one two three";
const result = await runPipeline(pipeline, { text });
if (result.status !== "completed") throw new Error(JSON.stringify(result.error ?? result.status));
console.log(JSON.stringify({ runId: result.runId, output: result.output }));
