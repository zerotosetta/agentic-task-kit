import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(projectRoot, "src");
const entries = [];
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      await inspect(file);
      continue;
    }
    if (/\.tsx?$/u.test(file)) entries.push(file);
  }
}
await inspect(root);
// Inspect resolved runtime imports, excluding erased type-only imports.
const { metafile } = await build({
  absWorkingDir: projectRoot,
  entryPoints: entries,
  outdir: ".architecture-check",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  jsx: "automatic",
  write: false,
  metafile: true,
});
const graph = new Map(
  Object.entries(metafile.inputs).map(([file, input]) => [
    resolve(projectRoot, file),
    input.imports
      .filter((dependency) => !dependency.external && dependency.kind === "import-statement")
      .map((dependency) => resolve(projectRoot, dependency.path)),
  ]),
);
const completed = new Set();
function visit(file, chain = []) {
  assert.ok(
    !chain.includes(file),
    `Runtime import cycle: ${[...chain, file].map((path) => relative(root, path)).join(" -> ")}`,
  );
  if (completed.has(file)) return;
  for (const dependency of graph.get(file) ?? []) {
    assert.ok(graph.has(dependency), `Unresolved internal import ${dependency} from ${file}`);
    visit(dependency, [...chain, file]);
  }
  completed.add(file);
}
for (const file of graph.keys()) visit(file);
console.log(`Verified ${graph.size} source modules without runtime import cycles.`);
