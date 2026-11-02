import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = resolve(projectRoot, process.argv[2] ?? "dist");
let count = 0;

async function verifyDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      await verifyDirectory(file);
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      const module = await import(pathToFileURL(file).href);
      assert.equal(typeof module.createCycle, "function", `Missing public exports in ${file}`);
      count += 1;
    }
  }
}

await verifyDirectory(dist);
assert.ok(count > 1, "Expected the main bundle and declaration companion shims");
console.log(`Verified ESM imports for ${count} package modules.`);
