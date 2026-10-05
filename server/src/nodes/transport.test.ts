import type { FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { NodeReadBackpressure, sendTransferBody, writeTransferChunk } from "./transport.js";
import { decodeTransferChunk, nodeProtocolTransferChunkBytes } from "./protocol.js";

function socket() {
  return { OPEN: 1, readyState: 1, pause: vi.fn(), resume: vi.fn() };
}

describe("node transport backpressure", () => {
  it("only resumes when every blocked transfer has released its pause", () => {
    const ws = socket();
    const resumed = vi.fn();
    const pressure = new NodeReadBackpressure(ws as unknown as WebSocket, resumed);
    const first = {};
    const second = {};
    expect(pressure.pause(first)).toBe(true);
    expect(pressure.pause(first)).toBe(false);
    expect(pressure.pause(second)).toBe(true);
    expect(ws.pause).toHaveBeenCalledTimes(1);
    pressure.resume(first);
    pressure.resume(first);
    pressure.resume({});
    expect(pressure.paused).toBe(true);
    expect(ws.resume).not.toHaveBeenCalled();
    expect(resumed).not.toHaveBeenCalled();
    pressure.resume(second);
    expect(pressure.paused).toBe(false);
    expect(ws.resume).toHaveBeenCalledTimes(1);
    expect(resumed).toHaveBeenCalledTimes(1);
  });

  it("starts a new pause after a completed drain cycle", () => {
    const ws = socket();
    const pressure = new NodeReadBackpressure(ws as unknown as WebSocket, () => {});
    const owner = {};
    pressure.pause(owner);
    pressure.resume(owner);
    pressure.pause(owner);
    expect(pressure.paused).toBe(true);
    expect(ws.pause).toHaveBeenCalledTimes(2);
  });

  it("does not resume a disconnected socket", () => {
    const ws = socket();
    const pressure = new NodeReadBackpressure(ws as unknown as WebSocket, () => {});
    const owner = {};
    pressure.pause(owner);
    ws.readyState = 3;
    pressure.resume(owner);
    expect(pressure.paused).toBe(false);
    expect(ws.resume).not.toHaveBeenCalled();
  });
});

describe("node upload chunk writes", () => {
  it("retries partial writes in order without duplicating or losing bytes", async () => {
    const written: Buffer[] = [];
    const write = vi.fn(async (buffer: Buffer, offset: number, length: number) => {
      const bytesWritten = Math.min(3, length);
      written.push(Buffer.from(buffer.subarray(offset, offset + bytesWritten)));
      return { bytesWritten, buffer };
    });
    await writeTransferChunk({ write } as unknown as Pick<FileHandle, "write">, Buffer.from("ten bytes!"));
    expect(Buffer.concat(written).toString()).toBe("ten bytes!");
    expect(write.mock.calls.map(([, offset, length]) => [offset, length])).toEqual([[0, 10], [3, 7], [6, 4], [9, 1]]);
  });

  it("fails a non-progressing write rather than looping forever", async () => {
    const write = vi.fn(async () => ({ bytesWritten: 0 }));
    await expect(writeTransferChunk({ write } as unknown as Pick<FileHandle, "write">, Buffer.from("data"))).rejects.toThrow("no progress");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("propagates a filesystem failure after a partial write", async () => {
    const write = vi.fn().mockResolvedValueOnce({ bytesWritten: 2 }).mockRejectedValueOnce(new Error("ENOSPC"));
    await expect(writeTransferChunk({ write } as unknown as Pick<FileHandle, "write">, Buffer.from("data"))).rejects.toThrow("ENOSPC");
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("does not issue a filesystem write for an empty chunk", async () => {
    const write = vi.fn();
    await writeTransferChunk({ write } as unknown as Pick<FileHandle, "write">, Buffer.alloc(0));
    expect(write).not.toHaveBeenCalled();
  });
});

describe("node binary transfer sender", () => {
  const id = "00112233-4455-6677-8899-aabbccddeeff";

  it("splits large source chunks, preserves ordering, and digests exactly the transmitted bytes", async () => {
    const payload = Buffer.alloc(2 * nodeProtocolTransferChunkBytes + 31, 0x42);
    const frames: Buffer[] = [];
    const result = await sendTransferBody(Readable.from([payload, "end"]), id, payload.byteLength + 3, async (frame) => { frames.push(frame); });
    const chunks = frames.map((frame) => decodeTransferChunk(frame));
    expect(chunks.map((chunk) => chunk.id)).toEqual([id, id, id, id]);
    expect(chunks.map((chunk) => chunk.payload.byteLength)).toEqual([nodeProtocolTransferChunkBytes, nodeProtocolTransferChunkBytes, 31, 3]);
    const bytes = Buffer.concat(chunks.map((chunk) => chunk.payload));
    expect(bytes.equals(Buffer.concat([payload, Buffer.from("end")]))).toBe(true);
    expect(result).toEqual({ size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") });
  });

  it("waits for each send to complete before sending another frame", async () => {
    let complete!: () => void;
    const send = vi.fn(() => new Promise<void>((resolve) => { complete = resolve; }));
    const pending = sendTransferBody(Readable.from([Buffer.alloc(nodeProtocolTransferChunkBytes + 1)]), id, nodeProtocolTransferChunkBytes + 1, send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setImmediate(resolve));
    expect(send).toHaveBeenCalledTimes(1);
    complete();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    complete();
    await expect(pending).resolves.toMatchObject({ size: nodeProtocolTransferChunkBytes + 1 });
  });

  it("does not send bytes exceeding the declared limit and closes the source", async () => {
    const source = Readable.from([Buffer.from("first"), Buffer.from("excess")]);
    const send = vi.fn(async () => {});
    await expect(sendTransferBody(source, id, 5, send)).rejects.toThrow("declared limit");
    expect(send).toHaveBeenCalledTimes(1);
    expect(source.destroyed).toBe(true);
  });

  it("closes the source when a send fails", async () => {
    const source = Readable.from([Buffer.alloc(nodeProtocolTransferChunkBytes + 1)]);
    const send = vi.fn(async () => { throw new Error("disconnected"); });
    await expect(sendTransferBody(source, id, nodeProtocolTransferChunkBytes + 1, send)).rejects.toThrow("disconnected");
    expect(send).toHaveBeenCalledTimes(1);
    expect(source.destroyed).toBe(true);
  });

  it("finishes an empty transfer without sending a binary frame", async () => {
    const send = vi.fn(async () => {});
    await expect(sendTransferBody(Readable.from([]), id, 0, send)).resolves.toEqual({ size: 0, sha256: createHash("sha256").digest("hex") });
    expect(send).not.toHaveBeenCalled();
  });
});
