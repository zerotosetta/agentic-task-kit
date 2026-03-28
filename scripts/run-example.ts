import { createCycle, createCLIRenderer, ReportWorkflow } from "../src/index.js";

const requestedMode = process.env.CYCLE_RENDER_MODE as
  | "off"
  | "line"
  | "compact"
  | "dashboard"
  | "jsonl"
  | "plain"
  | undefined;

const renderer = createCLIRenderer(
  requestedMode
    ? {
        enabled: process.env.CYCLE_LIVE !== "0",
        mode: requestedMode
      }
    : {
        enabled: process.env.CYCLE_LIVE !== "0"
      }
);

const cycle = createCycle({
  observers: [renderer]
});

cycle.register("report", ReportWorkflow);

const { frame } = await cycle.run("report", {
  text: "Cycle should provide a reusable foundation for AX Workflow with memory, events, logs, and CLI rendering."
}, {
  rag: [
    {
      id: "design",
      text: "AX Workflow libraries should expose clear package APIs and observable execution events."
    }
  ]
});

process.stdout.write(
  `Example finished with status=${frame.status} completedTasks=${frame.completedTasks.join(",")}\n`
);
