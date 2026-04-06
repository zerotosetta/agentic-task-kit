import { mkdir, readFile, rm, writeFile, copyFile, cp, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, "..");
const distDir = resolve(projectRoot, "dist");
const outputDir = resolve(projectRoot, ".npm-package");

async function ensureDistExists() {
  try {
    const info = await stat(distDir);
    if (!info.isDirectory()) {
      throw new Error("dist is not a directory");
    }
  } catch (error) {
    throw new Error(
      `Build output not found at ${distDir}. Run \`npm run build\` before building the all-in-one package.`,
      { cause: error }
    );
  }
}

function createPublishManifest(rootManifest) {
  const publishManifest = {
    name: rootManifest.name,
    version: rootManifest.version,
    description: rootManifest.description,
    type: rootManifest.type,
    repository: rootManifest.repository,
    homepage: rootManifest.homepage,
    bugs: rootManifest.bugs,
    publishConfig: rootManifest.publishConfig,
    main: "./dist/index.js",
    types: "./dist/index.d.ts",
    exports: rootManifest.exports,
    files: ["dist", "README.md", "LICENSE"],
    keywords: rootManifest.keywords,
    engines: rootManifest.engines,
    license: rootManifest.license
  };

  return publishManifest;
}

async function main() {
  await ensureDistExists();

  const packageJsonPath = resolve(projectRoot, "package.json");
  const readmePath = resolve(projectRoot, "README.md");
  const licensePath = resolve(projectRoot, "LICENSE");
  const rootManifest = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const publishManifest = createPublishManifest(rootManifest);

  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });
  await cp(distDir, resolve(outputDir, "dist"), {
    recursive: true,
    filter: (source) => !source.endsWith(".map")
  });
  await copyFile(readmePath, resolve(outputDir, "README.md"));
  await copyFile(licensePath, resolve(outputDir, "LICENSE"));

  await writeFile(
    resolve(outputDir, "package.json"),
    `${JSON.stringify(publishManifest, null, 2)}\n`,
    "utf8"
  );

  process.stdout.write(`all-in-one npm package prepared at ${outputDir}\n`);
}

await main();
