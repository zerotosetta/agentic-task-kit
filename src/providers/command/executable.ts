import { open, readFile, stat } from "node:fs/promises";
import {
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from "node:path";

export function commandEnvironment(
  overrides: Record<string, string | null> = {},
): NodeJS.ProcessEnv {
  const result = { ...process.env };
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !key ||
      /[=\0]/u.test(key) ||
      (value !== null && (typeof value !== "string" || value.includes("\0")))
    )
      throw new Error("Command environment contains an invalid name or value.");
    if (process.platform === "win32")
      for (const current of Object.keys(result))
        if (current.toLowerCase() === key.toLowerCase()) delete result[current];
    if (value === null) delete result[key];
    else result[key] = value;
  }
  return result;
}

export async function resolveCommandExecutable(
  executable: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<{ file: string; prefix: string[] }> {
  if (process.platform !== "win32") return { file: executable, prefix: [] };
  const variable = (name: string) =>
    Object.entries(env).find(([key]) => key.toLowerCase() === name)?.[1];
  const roots =
    isAbsolute(executable) || /[\\/]/u.test(executable)
      ? [resolve(cwd, executable)]
      : (variable("path") ?? "")
          .split(delimiter)
          .map((entry) =>
            join(resolve(cwd, entry.replace(/^"|"$/gu, "")), executable),
          );
  const extensions = (variable("pathext") ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => /^\.(?:exe|com|cmd|bat)$/iu.test(extension));
  let file: string | undefined;
  for (const root of roots) {
    for (const candidate of extname(root)
      ? [root]
      : [root, ...extensions.map((extension) => root + extension)]) {
      if (
        await stat(candidate).then(
          (value) => value.isFile(),
          () => false,
        )
      ) {
        file = candidate;
        break;
      }
    }
    if (file) break;
  }
  if (!file)
    throw Object.assign(
      new Error("Command executable was not found in the configured path."),
      { code: "ENOENT" },
    );
  if (!/\.(?:cmd|bat)$/iu.test(file)) return { file, prefix: [] };
  const unsupported = () =>
    Object.assign(
      new Error(
        "Command .cmd/.bat wrapper is not a supported npm Node shim. Configure a native executable, or node with the CLI script in args.",
      ),
      { code: "command_unsupported_script" },
    );
  if ((await stat(file)).size > 65536) throw unsupported();
  const wrapper = await readFile(file, "utf8");
  const entry = /"%_prog%"\s+"%dp0%([\\/][^"\r\n]+)"\s+%\*/iu.exec(wrapper);
  if (!/SET\s+"_prog=node"/iu.test(wrapper) || !entry) throw unsupported();
  const script = resolve(dirname(file), entry[1]!.slice(1));
  if (!/\.(?:cjs|mjs|js)$/iu.test(script)) {
    const handle = await open(script, "r");
    try {
      const buffer = Buffer.alloc(256);
      const { bytesRead } = await handle.read(buffer);
      if (
        !/^#!(?:\/usr\/bin\/env\s+node|[^\r\n]*\/node)[ \t]*(?:\r?\n|$)/u.test(
          buffer.subarray(0, bytesRead).toString(),
        )
      )
        throw unsupported();
    } finally {
      await handle.close();
    }
  }
  return { file: process.execPath, prefix: [script] };
}
