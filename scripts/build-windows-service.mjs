import { execFileSync } from "node:child_process";
import { cp, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = join(root, ".npm-package");
const output = join(root, "out", "pipeline-sdk");
const template = join(root, "templates", "windows-service");

async function runtimeLicense() {
  const supplied = process.env.ATK_NODE_LICENSE_FILE;
  if (supplied) return readFile(resolve(supplied));
  try {
    return await readFile(join(dirname(process.execPath), "LICENSE"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const url = "https://raw.githubusercontent.com/nodejs/node/" + process.version + "/LICENSE";
  const response = await fetch(url, {signal: AbortSignal.timeout(60_000)});
  if (!response.ok) throw new Error("Cannot retrieve " + url + ". Set ATK_NODE_LICENSE_FILE to this runtime's LICENSE.");
  return Buffer.from(await response.arrayBuffer());
}

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Use Windows x64 Node.js to build the portable service.");
const {name, version} = JSON.parse(await readFile(join(pkg, "package.json"), "utf8"));
const sourceVersion = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
if (name !== "agentic-task-kit" || version !== sourceVersion || !/^[\w.-]+$/.test(version)) {
  throw new Error("Rebuild .npm-package from the current package before creating the Windows ZIP.");
}
const license = await runtimeLicense();
if (!license.toString("utf8").includes("Node.js") || !license.toString("utf8").includes("Permission is hereby granted")) {
  throw new Error("The runtime license file does not contain the Node.js license.");
}
const stage = await mkdtemp(join(tmpdir(), "atk-win-package-"));
try {
  await mkdir(output, {recursive: true});
  const destination = join(output, "atk-session-service-" + version + "-win-x64.zip");
  const payload = join(stage, "payload");
  await mkdir(join(payload, "node_modules"), {recursive: true});
  await cp(pkg, join(payload, "node_modules", name), {recursive: true});
  await mkdir(join(payload, "runtime"));
  await copyFile(process.execPath, join(payload, "runtime", "node.exe"));
  await writeFile(join(payload, "runtime", "LICENSE"), license);
  for (const file of ["start-atk.cmd", "start-atk.mjs", "README.md"]) {
    await copyFile(join(template, file), join(payload, file));
  }
  // Keep the temporary archive on the output volume for atomic replacement.
  const scratch = await mkdtemp(join(output, ".win-package-"));
  try {
    const archive = join(scratch, "service.zip");
    const tar = join(process.env.SystemRoot, "System32", "tar.exe");
    execFileSync(tar, ["-a", "-cf", archive, "-C", payload, "."], {windowsHide: true, stdio: "inherit"});
    await rename(archive, destination);
  } finally {
    await rm(scratch, {recursive: true, force: true});
  }
  console.log(destination);
} finally {
  await rm(stage, {recursive: true, force: true});
}
