import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import type { ManagedNode } from "../types.js";
import { PanelNodeConnections } from "./panelConnections.js";
import { encodeTransferChunk, nodeCapabilities, nodeFeatures, nodeProtocolVersion } from "./protocol.js";

class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Array<string | Buffer> = [];
  closed?: { code?: number; reason?: string };
  pingCount = 0;
  terminated = false;
  onSend?: (value: string | Buffer) => void;

  send(value: string | Buffer, optionsOrCallback?: unknown, callback?: (error?: Error) => void) {
    this.sent.push(value);
    this.onSend?.(value);
    const done = typeof optionsOrCallback === "function" ? optionsOrCallback as (error?: Error) => void : callback;
    done?.();
  }

  paused = false;

  ping() { this.pingCount += 1; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  terminate() { this.terminated = true; this.readyState = 3; this.emit("close", 1006, Buffer.alloc(0)); }
  close(code?: number, reason?: string) { this.closed = { code, reason }; this.readyState = 3; this.emit("close", code ?? 1000, Buffer.from(reason ?? "")); }
}

function node(): ManagedNode {
  return {
    id: "node-1", name: "Node", type: "remote", status: "online", isInternal: false,
    protocolVersion: nodeProtocolVersion, capabilities: [...nodeCapabilities], features: [...nodeFeatures],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function emitJson(socket: FakeSocket, value: unknown) {
  socket.emit("message", Buffer.from(JSON.stringify(value)), false);
}

describe("PanelNodeConnections", () => {
  it("exposes negotiated metadata only for the active node connection", () => {
    const connections = new PanelNodeConnections();
    const socket = new FakeSocket();
    const connected = node();

    connections.connect(connected, socket as unknown as WebSocket);
    expect(connections.connectedNode(connected.id)).toBe(connected);

    socket.close();
    expect(connections.connectedNode(connected.id)).toBeUndefined();
    connections.close();
  });

  it("sends cancellation on deadline and safely ignores a late response", async () => {
    const connections = new PanelNodeConnections();
    const socket = new FakeSocket();
    connections.connect(node(), socket as unknown as WebSocket);
    const pending = connections.request(node(), "server.inspect", {}, 5);
    await expect(pending).rejects.toMatchObject({ code: "command_timeout" });
    const request = socket.sent.map(String).map((value) => JSON.parse(value)).find((value) => value.type === "request");
    expect(socket.sent.map(String).map((value) => JSON.parse(value))).toContainEqual(expect.objectContaining({ type: "cancel", id: request.id }));
    expect(() => emitJson(socket, { type: "response", id: request.id, ok: true, result: {} })).not.toThrow();
    connections.close();
  });

  it("negotiates cancellation from the live session when the stored record has no features", async () => {
    // Features are negotiated per session and never persisted, so a node resolved through the
    // repository has none. Cancellation must still be negotiated from the connected session.
    const stored = { ...node(), features: undefined };
    const connections = new PanelNodeConnections();
    const socket = new FakeSocket();
    connections.connect(node(), socket as unknown as WebSocket);

    const pending = connections.request(stored, "server.inspect", {}, 5);
    await expect(pending).rejects.toMatchObject({ code: "command_timeout" });

    const frames = socket.sent.map(String).map((value) => JSON.parse(value));
    const request = frames.find((value) => value.type === "request");
    expect(request.deadlineMs).toBe(5);
    expect(frames).toContainEqual(expect.objectContaining({ type: "cancel", id: request.id }));
    connections.close();
  });

  it("closes a superseded socket and rejects its pending work", async () => {
    const connections = new PanelNodeConnections();
    const first = new FakeSocket();
    const second = new FakeSocket();
    connections.connect(node(), first as unknown as WebSocket);
    const pending = connections.request(node(), "server.inspect", {}, 1_000);
    connections.connect(node(), second as unknown as WebSocket);
    await expect(pending).rejects.toMatchObject({ code: "node_offline" });
    expect(first.closed).toEqual({ code: 4000, reason: "Replaced by a newer node session" });
    connections.close();
  });

  it("pings every 15 seconds and terminates a connection without pong by 35 seconds", () => {
    vi.useFakeTimers();
    try {
      const connections = new PanelNodeConnections();
      const socket = new FakeSocket();
      connections.connect(node(), socket as unknown as WebSocket);
      vi.advanceTimersByTime(30_000);
      expect(socket.pingCount).toBe(2);
      expect(socket.terminated).toBe(false);
      vi.advanceTimersByTime(5_000);
      expect(socket.terminated).toBe(true);
      expect(connections.isConnected(node().id)).toBe(false);
      connections.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("streams ordered upload chunks and completes after node integrity validation", async () => {
    const connections = new PanelNodeConnections();
    const socket = new FakeSocket();
    socket.onSend = (value) => {
      if (typeof value !== "string") return;
      const message = JSON.parse(value);
      if (message.type === "transferStart") queueMicrotask(() => emitJson(socket, { type: "transferReady", id: message.id }));
      if (message.type === "transferFinish") queueMicrotask(() => emitJson(socket, { type: "transferResult", id: message.id, ok: true, result: { size: message.size } }));
    };
    connections.connect(node(), socket as unknown as WebSocket);
    await expect(connections.upload(node(), "files.upload", {}, Readable.from(Buffer.from("payload")), 7)).resolves.toEqual({ size: 7 });
    const binary = socket.sent.filter(Buffer.isBuffer);
    expect(binary).toHaveLength(1);
    expect(binary[0][0]).toBe(0x01);
    connections.close();
  });

  it("verifies streamed downloads before ending the consumer stream", async () => {
    const connections = new PanelNodeConnections();
    const socket = new FakeSocket();
    socket.onSend = (value) => {
      if (typeof value !== "string") return;
      const message = JSON.parse(value);
      if (message.type !== "transferStart") return;
      queueMicrotask(() => {
        emitJson(socket, { type: "transferReady", id: message.id, filename: "file.txt", size: 4 });
        socket.emit("message", encodeTransferChunk(message.id, Buffer.from("data")), true);
        emitJson(socket, { type: "transferFinish", id: message.id, size: 4, sha256: "3a6eb0790f39ac87c94f3856b2dd2c5d110e6811602261a9a923d3bb23adc8b7" });
      });
    };
    connections.connect(node(), socket as unknown as WebSocket);
    const download = await connections.download(node(), "files.download", {}, 1024);
    const chunks: Buffer[] = [];
    for await (const chunk of download.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("data");
    connections.close();
  });

  it("keeps a node connected while its socket is paused for download backpressure", async () => {
    vi.useFakeTimers();
    try {
      const connections = new PanelNodeConnections();
      const socket = new FakeSocket();
      socket.onSend = (value) => {
        if (typeof value !== "string") return;
        const message = JSON.parse(value);
        if (message.type !== "transferStart") return;
        queueMicrotask(() => emitJson(socket, { type: "transferReady", id: message.id, filename: "world.zip", size: 8 * 1024 * 1024 }));
      };
      connections.connect(node(), socket as unknown as WebSocket);
      const download = await connections.download(node(), "files.download", {}, 8 * 1024 * 1024);
      const transferId = socket.sent.map(String).map((value) => JSON.parse(value)).find((value) => value.type === "transferStart").id;

      // Nobody drains the stream, so the first chunk past its high-water mark pauses the socket.
      socket.emit("message", encodeTransferChunk(transferId, Buffer.alloc(256 * 1024)), true);
      expect(socket.paused).toBe(true);

      // No pong can arrive while the socket is paused, and a large export holds it open for far
      // longer than the pong timeout. Terminating there kills a healthy transfer.
      vi.advanceTimersByTime(120_000);
      expect(socket.terminated).toBe(false);
      expect(connections.isConnected(node().id)).toBe(true);
      expect(socket.pingCount).toBeGreaterThan(0);

      download.stream.resume();
      await vi.advanceTimersByTimeAsync(1);
      expect(socket.paused).toBe(false);

      // Reads are flowing again, so the pong clock restarts rather than carrying the pause forward.
      vi.advanceTimersByTime(30_000);
      expect(socket.terminated).toBe(false);
      vi.advanceTimersByTime(10_000);
      expect(socket.terminated).toBe(true);
      connections.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails a download stream instead of raising an unhandled error when the node drops", async () => {
    const connections = new PanelNodeConnections();
    const socket = new FakeSocket();
    socket.onSend = (value) => {
      if (typeof value !== "string") return;
      const message = JSON.parse(value);
      if (message.type !== "transferStart") return;
      queueMicrotask(() => emitJson(socket, { type: "transferReady", id: message.id, filename: "world.zip", size: 1024 }));
    };
    connections.connect(node(), socket as unknown as WebSocket);
    const download = await connections.download(node(), "files.download", {}, 1024);

    // No consumer has attached an error handler: yazl pipes archive members without one. An
    // unhandled 'error' here exits the process, which is what ended a 7 GiB export mid-flight.
    socket.close();
    await new Promise((resolve) => setImmediate(resolve));

    expect(download.stream.destroyed).toBe(true);
    expect(download.stream.errored).toMatchObject({ code: "node_offline" });
    connections.close();
  });

  it("rejects a download whose SHA-256 does not match", async () => {
    const connections = new PanelNodeConnections();
    const socket = new FakeSocket();
    socket.onSend = (value) => {
      if (typeof value !== "string") return;
      const message = JSON.parse(value);
      if (message.type !== "transferStart") return;
      queueMicrotask(() => {
        emitJson(socket, { type: "transferReady", id: message.id, filename: "bad.txt", size: 4 });
        socket.emit("message", encodeTransferChunk(message.id, Buffer.from("data")), true);
        emitJson(socket, { type: "transferFinish", id: message.id, size: 4, sha256: "0".repeat(64) });
      });
    };
    connections.connect(node(), socket as unknown as WebSocket);
    const download = await connections.download(node(), "files.download", {}, 1024);
    const drain = async () => { for await (const _chunk of download.stream) { /* drain */ } };
    await expect(drain()).rejects.toMatchObject({ code: "transfer_integrity_failed" });
    expect(socket.sent.map(String).map((value) => JSON.parse(value)).some((value) => value.type === "transferResult" && value.ok === false)).toBe(true);
    connections.close();
  });
});
