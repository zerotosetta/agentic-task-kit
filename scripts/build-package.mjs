import { builtinModules } from "node:module";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { build } from "esbuild";

const external = builtinModules.flatMap((name) => [name, `node:${name}`]);
const distDir = "dist";

await build({
  entryPoints: ["src/index.ts"],
  outfile: `${distDir}/index.js`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  legalComments: "none",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);'
  },
  external
});

const declarationFiles = await listDeclarationFiles(distDir);

for (const declarationFile of declarationFiles) {
  if (declarationFile === join(distDir, "index.d.ts")) {
    continue;
  }

  const shimPath = declarationFile.replace(/\.d\.ts$/u, ".js");
  const relativeIndexPath = relative(dirname(shimPath), join(distDir, "index.js"));
  const importPath = relativeIndexPath.startsWith(".")
    ? relativeIndexPath
    : `./${relativeIndexPath}`;

  await mkdir(dirname(shimPath), { recursive: true });
  await writeFile(shimPath, `export * from ${JSON.stringify(importPath)};\n`, "utf8");
}

async function listDeclarationFiles(rootDir) {
  const entries = await readdir(rootDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absolutePath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listDeclarationFiles(absolutePath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const details = await stat(absolutePath);
    if (!details.isFile()) {
      continue;
    }

    if (absolutePath.endsWith(".d.ts")) {
      files.push(absolutePath);
    }
  }

  return files;
}
