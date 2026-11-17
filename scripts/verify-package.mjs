import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(projectRoot, process.argv[2] ?? "dist");
const cli = resolve(dist, "atk-mcp.js");
const expectedExports = JSON.parse(
  await readFile(resolve(projectRoot, "scripts/public-exports.json"), "utf8"),
);
let count = 0;

async function verifyDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await verifyDirectory(file);
    } else if (entry.isFile() && entry.name.endsWith(".js") && file !== cli) {
      const module = await import(pathToFileURL(file).href);
      assert.deepEqual(
        Object.keys(module).sort(),
        expectedExports,
        `Public exports changed in ${file}`,
      );
      assert.equal(typeof module.createCycle, "function", `Missing public exports in ${file}`);
      count += 1;
    }
  }
}

await verifyDirectory(dist);
assert.ok(count > 1, "Expected the main bundle and declaration companion shims");
assert.match(execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" }), /atk-mcp --config/u);
console.log(`Verified ESM imports for ${count} package modules.`);
