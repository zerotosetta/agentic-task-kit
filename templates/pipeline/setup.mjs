import { writeFile } from "node:fs/promises";
import { descriptor as fixed } from "./workflow.mjs";
import { descriptor as planned } from "./agent.mjs";
import { descriptor as submitted } from "./submitted.mjs";

await writeFile(new URL("./atk-mcp.json", import.meta.url), JSON.stringify({
  stateDirectory: "./state",
  profiles: {
    "word-report": { module: "./workflow.mjs", ...fixed },
    "planned-report": { module: "./agent.mjs", ...planned },
    "submitted-report": { module: "./submitted.mjs", ...submitted },
  },
}, null, 2) + "\n", { flag: "wx" });
