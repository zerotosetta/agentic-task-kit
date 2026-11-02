import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src");
const graph = new Map();
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      await inspect(file);
      continue;
    }
    if (!/\.tsx?$/u.test(file)) continue;
    const output = ts.transpileModule(await readFile(file, "utf8"), {
      fileName: file,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    const parsed = ts.createSourceFile(file, output, ts.ScriptTarget.Latest, true);
    const dependencies = parsed.statements
      .filter((node) => ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
      .flatMap((node) =>
        node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
          ? [node.moduleSpecifier.text]
          : [],
      )
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => resolve(dirname(file), specifier));
    graph.set(file, dependencies);
  }
}
await inspect(root);
const completed = new Set();
function visit(file, chain = []) {
  assert.ok(
    !chain.includes(file),
    `Runtime import cycle: ${[...chain, file].map((path) => relative(root, path)).join(" -> ")}`,
  );
  if (completed.has(file)) return;
  for (const dependency of graph.get(file) ?? []) {
    const target = [
      dependency,
      dependency.replace(/\.js$/u, ".ts"),
      dependency.replace(/\.js$/u, ".tsx"),
    ].find((candidate) => graph.has(candidate));
    assert.ok(target, `Unresolved internal import ${dependency} from ${file}`);
    visit(target, [...chain, file]);
  }
  completed.add(file);
}
for (const file of graph.keys()) visit(file);
console.log(`Verified ${graph.size} source modules without runtime import cycles.`);
