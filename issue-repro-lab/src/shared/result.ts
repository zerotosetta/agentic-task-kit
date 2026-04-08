import { pathToFileURL } from "node:url";

export type IssueReproResult = {
  issue: number;
  title: string;
  reproduced: boolean;
  rootCause: string;
  evidence: Record<string, unknown>;
};

export function printIssueResult(result: IssueReproResult): void {
  console.log(JSON.stringify(result, null, 2));
}

export function isDirectExecution(importMetaUrl: string): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  return pathToFileURL(entry).href === importMetaUrl;
}
