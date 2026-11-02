/** Finish terminal cleanup before letting Windows tear down native async handles. */
export function exitAfterTerminalCleanup(exitCode: number): void {
  if (process.platform !== "win32") {
    process.exit(exitCode);
  }

  process.exitCode = exitCode;
  // Let the run's continuation finish first: consumer runners may resume stdin.
  // Immediate process.exit() after Ink unmount can abort in libuv on Windows.
  setImmediate(() => {
    process.stdin.pause();
    process.stdin.unref?.();
  });
}
