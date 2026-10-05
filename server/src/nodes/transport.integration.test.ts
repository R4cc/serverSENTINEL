import { createHash } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import type { ManagedNode } from "../types.js";
import { PanelNodeConnections } from "./panelConnections.js";
import { nodeCapabilities, nodeFeatures, nodeProtocolTransferChunkBytes, nodeProtocolVersion } from "./protocol.js";

async function session() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0, perMessageDeflate: false });
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing WebSocket test port");
  const accepted = once(server, "connection");
  const peer = new WebSocket(`ws://127.0.0.1:${address.port}`, { perMessageDeflate: false });
  await once(peer, "open");
  const [socket] = await accepted as [WebSocket];
  const connections = new PanelNodeConnections();
  const node: ManagedNode = {
    id: "node-1", name: "Node", type: "remote", status: "online", isInternal: false,
    protocolVersion: nodeProtocolVersion, capabilities: [...nodeCapabilities], features: [...nodeFeatures],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
  connections.connect(node, socket);
  return {
    peer, connections, node,
    async close() {
      connections.close();
      peer.terminate();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

function send(peer: WebSocket, value: unknown) {
  peer.send(JSON.stringify(value));
}

describe("protocol 3.1 transport over real WebSockets", () => {
  it("uploads several bounded chunks to a peer using the existing binary frame format", async () => {
    const { peer, connections, node, close } = await session();
    try {
      const data = Buffer.alloc(2 * nodeProtocolTransferChunkBytes + 37, 0x42);
      const received: Buffer[] = [];
      const ids: string[] = [];
      peer.on("message", (raw, binary) => {
        const bytes = Buffer.from(raw as Buffer);
        if (binary) {
          ids.push(bytes.subarray(1, 17).toString("hex"));
          received.push(bytes.subarray(17));
          return;
        }
        const message = JSON.parse(bytes.toString());
        if (message.type === "transferStart") send(peer, { type: "transferReady", id: message.id });
        if (message.type === "transferFinish") {
          const bytes = Buffer.concat(received);
          const ok = bytes.byteLength === message.size && createHash("sha256").update(bytes).digest("hex") === message.sha256;
          send(peer, { type: "transferResult", id: message.id, ok, result: { size: bytes.byteLength } });
        }
      });
      await expect(connections.upload(node, "files.upload", {}, Readable.from([data]), data.byteLength)).resolves.toEqual({ size: data.byteLength });
      expect(Buffer.concat(received).equals(data)).toBe(true);
      expect(received.map((chunk) => chunk.byteLength)).toEqual([nodeProtocolTransferChunkBytes, nodeProtocolTransferChunkBytes, 37]);
      expect(new Set(ids).size).toBe(1);
      expect(ids[0]).toHaveLength(32);
    } finally { await close(); }
  });

  it("drains and verifies a download framed by an unchanged 3.1 peer", async () => {
    const { peer, connections, node, close } = await session();
    try {
      const data = Buffer.alloc(3 * nodeProtocolTransferChunkBytes + 19, 0x63);
      let acknowledged!: (value: unknown) => void;
      const ack = new Promise((resolve) => { acknowledged = resolve; });
      peer.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "transferResult") acknowledged(message);
        if (message.type !== "transferStart") return;
        send(peer, { type: "transferReady", id: message.id, filename: "world.zip", size: data.byteLength });
        // Deliberately use the original encoder rather than the optimized implementation.
        const uuid = Buffer.from(message.id.replaceAll("-", ""), "hex");
        for (let offset = 0; offset < data.byteLength; offset += nodeProtocolTransferChunkBytes) {
          peer.send(Buffer.concat([Buffer.from([0x01]), uuid, data.subarray(offset, offset + nodeProtocolTransferChunkBytes)]));
        }
        send(peer, { type: "transferFinish", id: message.id, size: data.byteLength, sha256: createHash("sha256").update(data).digest("hex") });
      });
      const download = await connections.download(node, "files.download", {}, data.byteLength);
      const received: Buffer[] = [];
      for await (const chunk of download.stream) received.push(Buffer.from(chunk));
      expect(download.filename).toBe("world.zip");
      expect(Buffer.concat(received).equals(data)).toBe(true);
      await expect(ack).resolves.toMatchObject({ type: "transferResult", ok: true });
    } finally { await close(); }
  });

  it("uses the existing cancel message for caller cancellation", async () => {
    const { peer, connections, node, close } = await session();
    try {
      let started!: (value: { id: string; deadlineMs: number }) => void;
      const start = new Promise<{ id: string; deadlineMs: number }>((resolve) => { started = resolve; });
      let cancelled!: (value: unknown) => void;
      const cancel = new Promise((resolve) => { cancelled = resolve; });
      peer.on("message", (raw) => {
        const message = JSON.parse(raw.toString());
        if (message.type === "request") started(message);
        if (message.type === "cancel") cancelled(message);
      });
      const controller = new AbortController();
      const pending = connections.request(node, "server.inspect", {}, 1_000, controller.signal);
      const rejected = expect(pending).rejects.toMatchObject({ code: "command_cancelled" });
      const request = await start;
      expect(request.deadlineMs).toBe(1_000);
      controller.abort();
      await rejected;
      await expect(cancel).resolves.toMatchObject({ type: "cancel", id: request.id });
    } finally { await close(); }
  });
});
