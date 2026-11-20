import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const state = resolve(root, process.env.ATK_STATE_DIRECTORY || "data");
const port = process.env.ATK_SERVICE_PORT || "4317";
const cli = join(root, "node_modules", "agentic-task-kit", "dist", "atk-mcp.js");

async function persistentToken() {
  const path = join(state, "access-token.txt");
  const token = randomBytes(32).toString("base64url");
  try {
    await writeFile(path, token + "\n", {flag: "wx", mode: 0o600, flush: true});
    return token;
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  // A second launcher can observe the file just before the creator finishes writing.
  for (let attempt = 0; attempt < 20; attempt++) {
    const existing = (await readFile(path, "utf8")).trim();
    if (existing) return existing;
    await delay(50);
  }
  throw new Error("Empty access-token.txt. Restore the file or remove it to generate a replacement.");
}

try {
  await mkdir(state, {recursive: true});
  if (!Object.hasOwn(process.env, "ATK_SERVICE_TOKEN")) process.env.ATK_SERVICE_TOKEN = await persistentToken();
  process.argv = [process.execPath, cli, "serve", "--state", state, "--host", "127.0.0.1", "--port", port];
  await import(pathToFileURL(cli).href);
} catch (error) {
  console.error("ATK launcher:", error.message);
  process.exitCode = 1;
}
