import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import type WebSocket from "ws";
import { createTransferChunkEncoder, nodeProtocolTransferChunkBytes } from "./protocol.js";

/** A shared socket may have several blocked transfers, each owning its own pause. */
export class NodeReadBackpressure {
  private readonly blocked = new Set<object>();

  constructor(private readonly socket: WebSocket, private readonly onResume: () => void) {}

  get paused() { return this.blocked.size > 0; }

  pause(owner: object) {
    if (this.blocked.has(owner)) return false;
    if (!this.paused) this.socket.pause();
    this.blocked.add(owner);
    return true;
  }

  resume(owner: object) {
    if (!this.blocked.delete(owner) || this.paused) return;
    this.onResume();
    if (this.socket.readyState === this.socket.OPEN) this.socket.resume();
  }
}

export async function writeTransferChunk(file: Pick<FileHandle, "write">, chunk: Buffer) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("Upload write made no progress");
    offset += bytesWritten;
  }
}

/** Uploads and downloads share chunk bounds, digesting, and callback-based send pacing. */
export async function sendTransferBody(source: Readable, id: string, maxBytes: number, send: (frame: Buffer) => Promise<void>) {
  const encode = createTransferChunkEncoder(id);
  const hash = createHash("sha256");
  let size = 0;
  for await (const raw of source) {
    const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    for (let offset = 0; offset < buffer.byteLength; offset += nodeProtocolTransferChunkBytes) {
      const chunk = buffer.subarray(offset, offset + nodeProtocolTransferChunkBytes);
      size += chunk.byteLength;
      if (size > maxBytes) throw new Error("Transfer exceeded its declared limit");
      hash.update(chunk);
      await send(encode(chunk));
    }
  }
  return { size, sha256: hash.digest("hex") };
}
