import { createAgentPipeline, createAIProviderFromConfigFile } from "agentic-task-kit";
import { operations, objectSchema, reportSchema } from "./operations.mjs";

let provider;
function model() {
  const configPath = process.env.ATK_PLANNER_CONFIG;
  if (!configPath) throw new Error("Set ATK_PLANNER_CONFIG to plan a new report with a model.");
  return provider ??= createAIProviderFromConfigFile({ configPath });
}

export const pipeline = createAgentPipeline({
  key: "planned-report", revision: "1", description: "Plan a text report using the registered operations.",
  inputSchema: objectSchema({ goal: { type: "string" }, text: { type: "string" } }),
  outputSchema: reportSchema, operations,
  aiProvider: {
    provider: "configured-planner",
    chat: request => model().chat(request),
    chatStream: request => model().chatStream(request),
  },
});
export const { descriptor, createWorkflow } = pipeline;
