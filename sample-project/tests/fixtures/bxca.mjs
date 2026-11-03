import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  prompt: { type: "string", short: "p" },
  model: { type: "string", short: "m" },
  behavior: { type: "string", default: "success" },
} });
const stage = /^ATK_BXCA_STAGE=(analysis|plan|review)$/m.exec(values.prompt ?? "")?.[1];
assert.ok(stage, "stage must arrive in one -p argument");
const documents = JSON.parse(/<documents>\n([\s\S]*)\n<\/documents>/.exec(values.prompt)?.[1] ?? "null");
assert.equal(typeof documents.requirements, "string");
if (stage !== "analysis") assert.equal(documents.analysis, "# fixture analysis\n");
if (stage === "review") assert.equal(documents.plan, "# fixture plan\n");
if (process.env.BXCA_FIXTURE_TRACE) {
  await appendFile(process.env.BXCA_FIXTURE_TRACE, `${JSON.stringify({ stage, documents, model: values.model })}\n`);
}
if (values.behavior === "slow") await new Promise((done) => setTimeout(done, 2_000));
if (values.behavior === "fail-plan" && stage === "plan") {
  process.stderr.write("fixture plan failed\n");
  process.exitCode = 7;
} else {
  process.stdout.write(values.behavior === "empty" ? " \n" : `# fixture ${stage}\n`);
}
