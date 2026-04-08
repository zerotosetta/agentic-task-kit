import { Writable } from "node:stream";

export class CaptureWriteStream extends Writable {
  readonly chunks: string[] = [];
  columns = 120;
  rows = 40;
  isTTY = false;

  override _write(
    chunk: string | Uint8Array,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.chunks.push(
      typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    );
    callback();
  }

  text(): string {
    return this.chunks.join("");
  }
}

export function createCaptureWriteStream(): NodeJS.WriteStream & CaptureWriteStream {
  return new CaptureWriteStream() as NodeJS.WriteStream & CaptureWriteStream;
}
