import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  createCLIRenderer,
  createCycle,
  InMemoryArtifactStore,
  InMemoryMemoryStore,
  ReportWorkflow
} from "../src/index.js";

describe("Cycle foundation MVP", () => {
  it("runs the sample workflow end-to-end", async () => {
    const memoryStore = new InMemoryMemoryStore();
    const artifactStore = new InMemoryArtifactStore();
    const stream = new PassThrough();
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk.toString();
    });

    const renderer = createCLIRenderer({
      enabled: false,
      stream: stream as unknown as NodeJS.WriteStream
    });
    const cycle = createCycle({
      memoryStore,
      artifactStore,
      observers: [renderer],
      now: (() => {
        let current = 1_000;
        return () => ++current;
      })()
    });

    cycle.register("report", ReportWorkflow);
    const result = await cycle.run(
      "report",
      "Cycle foundation MVP should produce observable workflow results."
    );

    expect(result.frame.status).toBe("success");
    expect(result.frame.completedTasks).toEqual(["analyze", "publish"]);

    const summary = await memoryStore.get(
      `workflow.${result.frame.workflowId}.task.analyze.summary`
    );
    expect(summary?.category).toBe("summary");

    const artifacts = await artifactStore.list();
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]?.name).toBe("report.md");

    expect(output).toContain("workflow started");
    expect(output).toContain("task info analyze Starting analysis");
    expect(output).toContain("workflow completed");
    expect(output).not.toContain("task.log");
    expect(output).not.toContain("\u001B[");
  });
});
