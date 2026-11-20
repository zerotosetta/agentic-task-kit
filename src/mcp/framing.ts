import type { Readable } from "node:stream";

export const versions = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const maxFrameBytes = 1024 * 1024;

/** Null marks an oversized input line. Discard the rest of that line without buffering it. */
export async function* frames(input: Readable): AsyncGenerator<Buffer | null> {
  const parts: Buffer[] = [];
  let size = 0;
  let oversized = false;
  for await (const source of input) {
    const chunk = typeof source === "string" ? Buffer.from(source) : source as Buffer;
    let start = 0;
    while (start < chunk.length) {
      const delimiter = chunk.indexOf(0x0a, start);
      const end = delimiter === -1 ? chunk.length : delimiter;
      if (!oversized) {
        size += end - start;
        oversized = size > maxFrameBytes;
        if (oversized) parts.length = 0;
        else if (end > start) parts.push(chunk.subarray(start, end));
      }
      if (delimiter === -1) break;
      yield oversized ? null : Buffer.concat(parts, size);
      size = 0;
      oversized = false;
      parts.length = 0;
      start = delimiter + 1;
    }
  }
  if (oversized) yield null;
  else if (size > 0) yield Buffer.concat(parts, size);
}
