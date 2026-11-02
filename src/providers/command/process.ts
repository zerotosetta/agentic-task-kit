import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type {
  CommandExecutionResult,
  CommandProviderSettings,
} from "../../types.js";
import { commandEnvironment, resolveCommandExecutable } from "./executable.js";

function failure(
  code: string,
  message: string,
  result: CommandExecutionResult,
  cause?: unknown,
): Error {
  return Object.assign(new Error(message, { cause }), { code, error: result });
}

async function terminateTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((done) => {
      const killer = spawn(
        resolve(
          process.env.SystemRoot ?? "C:\\Windows",
          "System32",
          "taskkill.exe",
        ),
        ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, shell: false, stdio: "ignore" },
      );
      const finish = () => {
        clearTimeout(timer);
        done();
      };
      const timer = setTimeout(() => {
        killer.kill();
        child.kill("SIGKILL");
        done();
      }, 3000);
      killer.once("error", () => {
        child.kill("SIGKILL");
        finish();
      });
      killer.once("close", (code) => {
        if (code !== 0) child.kill("SIGKILL");
        finish();
      });
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    child.kill("SIGKILL");
    return;
  }
  // Kill the group even if its parent has already exited after SIGTERM.
  await delay(250);
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    /* The group has exited. */
  }
}

export async function runCommand(
  settings: CommandProviderSettings,
  args: string[],
  input: string | undefined,
  signal: AbortSignal,
): Promise<CommandExecutionResult> {
  const started = Date.now();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const result = (
    exitCode: number | null = null,
    exitSignal: NodeJS.Signals | null = null,
  ): CommandExecutionResult => ({
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
    exitCode,
    signal: exitSignal,
    elapsedMs: Date.now() - started,
  });
  const abortDetails = () =>
    signal.reason instanceof Error && signal.reason.name === "TimeoutError"
      ? { code: "command_timeout", message: "Command execution timed out." }
      : {
          code: "command_aborted",
          message: "Command execution was cancelled.",
        };
  const checkAbort = () => {
    if (signal.aborted) {
      const details = abortDetails();
      throw failure(details.code, details.message, result(), signal.reason);
    }
  };
  checkAbort();
  const env = commandEnvironment(settings.env);
  const cwd = resolve(settings.cwd ?? process.cwd());
  const executable = await resolveCommandExecutable(
    settings.executable,
    cwd,
    env,
  );
  checkAbort();
  return new Promise<CommandExecutionResult>((resolveResult, reject) => {
    const child = spawn(executable.file, [...executable.prefix, ...args], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let bytes = 0;
    let stopped: { code: string; message: string; cause?: unknown } | undefined;
    let termination: Promise<void> | undefined;
    const stop = (details: NonNullable<typeof stopped>) => {
      if (stopped || settled) return;
      stopped = details;
      termination = terminateTree(child);
    };
    const onAbort = () => stop({ ...abortDetails(), cause: signal.reason });
    const capture = (target: Buffer[], chunk: Buffer) => {
      if (stopped || settled) return;
      const available = (settings.maxOutputBytes ?? 10 * 1024 * 1024) - bytes;
      target.push(chunk.subarray(0, Math.max(0, available)));
      bytes += chunk.length;
      if (chunk.length > available)
        stop({
          code: "command_output_limit",
          message: "Command output exceeded maxOutputBytes.",
        });
    };
    const finish = async (
      code: number | null,
      exitSignal: NodeJS.Signals | null,
      spawnError?: Error,
    ) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      try {
        await termination;
      } catch (error) {
        reject(
          failure(
            "command_termination_error",
            "Command termination failed.",
            result(code, exitSignal),
            error,
          ),
        );
        return;
      }
      const raw = result(code, exitSignal);
      if (stopped)
        reject(failure(stopped.code, stopped.message, raw, stopped.cause));
      else if (spawnError) reject(spawnError);
      else if (code !== 0)
        reject(
          failure("command_exit_error", "Command exited unsuccessfully.", raw),
        );
      else resolveResult(raw);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => {
      void finish(null, null, error);
    });
    child.once("close", (code, exitSignal) => {
      void finish(code, exitSignal);
    });
    child.stdin.on("error", (error: Error) => {
      if (input !== undefined)
        stop({
          code: "command_stdin_error",
          message: "Command stdin could not be written.",
          cause: error,
        });
    });
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    child.stdin.end(input);
  });
}
