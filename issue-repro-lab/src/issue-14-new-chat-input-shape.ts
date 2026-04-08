import ts from "typescript";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  isDirectExecution,
  printIssueResult,
  type IssueReproResult
} from "./shared/result.js";

function toLine(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
  if (!diagnostic.file || diagnostic.start === undefined) {
    return message;
  }

  const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(
    diagnostic.start
  );
  return `${diagnostic.file.fileName}:${line + 1}:${character + 1} ${message}`;
}

export function runIssue14Repro(): IssueReproResult {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const fixtureFile = path.resolve(
    thisDir,
    "../fixtures/issue-14-new-chat-input-shape.ts"
  );

  const program = ts.createProgram([fixtureFile], {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true
  });
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map(toLine);

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
