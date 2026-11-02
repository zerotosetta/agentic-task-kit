import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("renders source modules through a consumer loader using classic JSX", () => {
  const child = spawnSync(
    process.execPath,
    [
      resolve("node_modules/tsx/dist/cli.mjs"),
      "--tsconfig",
      resolve("tests/fixtures/tsconfig.classic.json"),
      resolve("tests/fixtures/classic-ink.tsx"),
    ],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr + child.stdout).toBe(0);
  expect(child.stdout).toContain("classic JSX passed");
}, 15_000);
