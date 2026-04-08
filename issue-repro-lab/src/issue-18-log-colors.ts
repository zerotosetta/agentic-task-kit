import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createCLIRenderer } from "../../dist/index.js";

import { createCaptureWriteStream } from "./shared/capture-stream.js";
import {
  isDirectExecution,
  printIssueResult,
  type IssueReproResult
} from "./shared/result.js";

export function runIssue18Repro(): IssueReproResult {
  const stream = createCaptureWriteStream();
  const tempDir = mkdtempSync(path.join(tmpdir(), "cycle-renderer-colors-"));
  const configPath = path.join(tempDir, "renderer-colors.json");
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        colors: {
          warn: "magenta"
        }
      },
      null,
      2
    )
  );

  try {
    const renderer = createCLIRenderer({
      enabled: false,
      mode: "line",
      stream,
      errorStream: stream,
      useColor: true,
      colorConfigPath: configPath
    });

    renderer.start();
    renderer.onTaskLog?.({
      timestamp: Date.UTC(2026, 3, 8, 12, 0, 0),
      workflowId: "issue-18",
      runId: "run-18",
      taskName: "warnTask",
      level: "warn",
      message: "warn line should be colorized"
    });
    renderer.stop("success");

    const output = stream.text();

    return {
      issue: 18,
      title: "로그 유형별 텍스트 색상 지정",
      reproduced: !output.includes("\u001B[35m"),
      rootCause:
        "renderer 가 log level 기본 색상 테마를 적용하지 않고, config file 에서 level 별 color override 를 읽는 경로도 없다.",
      evidence: {
        configPath,
        rendererOutput: output
      }
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

if (isDirectExecution(import.meta.url)) {
  const result = runIssue18Repro();
  printIssueResult(result);
}
