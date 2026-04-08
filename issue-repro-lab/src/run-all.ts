import { runIssue4Repro } from "./issue-4-prompt-output-monitoring.js";
import { runIssue14Repro } from "./issue-14-new-chat-input-shape.js";
import { runIssue15Repro } from "./issue-15-memory-write-drop.js";
import { runIssue16Repro } from "./issue-16-ink-stack-infinite.js";
import { runIssue17Repro } from "./issue-17-stack-trace-hidden.js";

const results = [
  await runIssue4Repro(),
  runIssue14Repro(),
  await runIssue15Repro(),
  runIssue16Repro(),
  await runIssue17Repro()
];

console.log(JSON.stringify(results, null, 2));
