import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import { extractSourceLocationFromStack } from "../src/error-location.js";

describe("Error source paths", () => {
  it("converts file URLs to native paths including spaces and Korean characters", () => {
    const file = resolve("한글 프로젝트", "task with spaces.ts");
    const location = extractSourceLocationFromStack(
      `Error: failure\n    at ConsumerTask.run (${pathToFileURL(file).href}:42:7)`
    );

    expect(location).toMatchObject({ file, line: 42, column: 7, functionName: "ConsumerTask.run" });
    expect(location?.display).toBe(`${relative(process.cwd(), file)}:42:7 ConsumerTask.run`);
  });

  it("skips dependency frames with Windows path separators", () => {
    const location = extractSourceLocationFromStack([
      "Error: failure",
      String.raw`    at DependencyTask.run (C:\project\node_modules\dependency\task.js:1:2)`,
      String.raw`    at ConsumerTask.run (C:\project\src\workflow.ts:42:7)`
    ].join("\n"));

    expect(location).toMatchObject({
      file: String.raw`C:\project\src\workflow.ts`,
      functionName: "ConsumerTask.run",
      line: 42,
      column: 7
    });
  });

  it.skipIf(process.platform !== "win32")("preserves UNC file URL paths", () => {
    const file = String.raw`\\server\share\한글 폴더\task.ts`;
    expect(extractSourceLocationFromStack(
      `Error: failure\n    at ConsumerTask.run (${pathToFileURL(file).href}:12:3)`
    )?.file).toBe(file);
  });
});
