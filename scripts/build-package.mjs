import { builtinModules } from "node:module";
import { chmod, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";

import { build } from "esbuild";

const external = builtinModules.flatMap((name) => [name, `node:${name}`]);
const distDir = "dist";

const requireBanner = 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);';
const bundleOptions = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: true,
  legalComments: "none",
  external
};
const cli = `${distDir}/atk-mcp.js`;
await Promise.all([
  build({
    ...bundleOptions,
    entryPoints: ["src/index.ts"],
    outfile: `${distDir}/index.js`,
    banner: { js: requireBanner },
  }),
  build({
    ...bundleOptions,
    entryPoints: ["src/mcp/cli.ts"],
    outfile: cli,
    banner: { js: "#!/usr/bin/env node\n" + requireBanner },
  }),
]);
await chmod(cli, 0o755);

const declarationFiles = await listDeclarationFiles(distDir);

for (const declarationFile of declarationFiles) {
  if (declarationFile === join(distDir, "index.d.ts")) {
    continue;
  }

  const shimPath = declarationFile.replace(/\.d\.ts$/u, ".js");
  const relativeIndexPath = relative(dirname(shimPath), join(distDir, "index.js"))
    .split(sep).join("/");
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
