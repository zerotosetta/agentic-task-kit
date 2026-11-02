import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe.skipIf(process.platform !== "win32")("Windows terminal shutdown", () => {
  it.each([0, 130])("drains pending work and preserves exit code %i", (exitCode) => {
    const moduleURL = new URL("../src/process-exit.ts", import.meta.url).href;
    const child = spawnSync(process.execPath, [
      "--import", "tsx", "--input-type=module", "-e",
      `import { exitAfterTerminalCleanup } from ${JSON.stringify(moduleURL)};
       setImmediate(() => process.stdout.write("cleanup completed"));
       exitAfterTerminalCleanup(${exitCode});
       process.stdin.resume();`
    ], { encoding: "utf8", timeout: 10_000 });

    expect(child.error).toBeUndefined();
    expect(child.stderr).not.toContain("Assertion failed");
    expect(child.stdout).toBe("cleanup completed");
    expect(child.status).toBe(exitCode);
  });
});
