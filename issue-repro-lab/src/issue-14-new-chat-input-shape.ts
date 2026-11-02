import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  isDirectExecution,
  printIssueResult,
  type IssueReproResult
} from "./shared/result.js";

export function runIssue14Repro(): IssueReproResult {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const fixtureFile = path.resolve(
    thisDir,
    "../fixtures/issue-14-new-chat-input-shape.ts"
  );

  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("typescript/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin: { tsc: string };
  };
  const result = spawnSync(process.execPath, [
    path.resolve(path.dirname(manifestPath), manifest.bin.tsc),
    "--ignoreConfig", "--target", "ES2022", "--module", "NodeNext",
    "--strict", "--noEmit", "--skipLibCheck", "--esModuleInterop",
    "--pretty", "false", fixtureFile
  ], {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true
  });
  if (result.error) throw result.error;
  const diagnostics = `${result.stdout}${result.stderr}`.trim().split(/\r?\n/u).filter(Boolean);
  if (result.status !== 0 && (result.status === null || diagnostics.length === 0)) {
    throw new Error(`TypeScript CLI failed: ${result.signal ?? result.status}`);
  }

  return {
    issue: 14,
    title: "신규 Chat API 입력 데이터 형식 지원 필요",
    reproduced: diagnostics.length > 0,
    rootCause:
      "public type surface 에서 `AISessionMessage.content` 가 `string` 으로 고정돼 있어 content-part 배열 형식이 provider layer 에 도달하기 전에 타입 단계에서 거부된다.",
    evidence: {
      fixtureFile,
      diagnostics
    }
  };
}

if (isDirectExecution(import.meta.url)) {
  const result = runIssue14Repro();
  printIssueResult(result);
}
