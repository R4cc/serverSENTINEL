import { createHash, randomUUID } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import type WebSocket from "ws";
import type { ManagedNode } from "../types.js";
import { assertNodeSupports, decodeTransferChunk, nodeAdvertisesFeature, nodeProtocolControlMessageMaxBytes, nodeProtocolMaxActiveRequests, nodeProtocolMaxActiveStreams, nodeProtocolMaxActiveTransfers, nodeProtocolVersion, normalizeNodeToPanelMessage, requireNodeCapability, structuredNodeProtocolError } from "./protocol.js";
import { NodeReadBackpressure, sendTransferBody } from "./transport.js";
import type { NodeCancelMessage, NodeCapability, NodeRequestMessage, NodeResponseMessage, NodeStreamDataMessage, NodeStreamEndMessage, NodeStreamEvent, NodeStreamStartMessage, NodeStreamStopMessage, NodeTransferCancelMessage, NodeTransferFinishMessage, NodeTransferReadyMessage, NodeTransferResultMessage, NodeTransferStartMessage } from "./protocol.js";

const heartbeatIntervalMs = 15_000;
const heartbeatTimeoutMs = 35_000;
const heartbeatCheckMs = 5_000;

type ConnectedNode = {
  /**
   * The node exactly as it handshook, which is the authority on negotiated transport features.
   * Features are per session and are deliberately not persisted, so a record resolved through the
   * repository has none: every `nodeAdvertisesFeature` check here must read this object rather than
   * a caller-supplied record, or the feature silently reads as unsupported.
   */
  node: ManagedNode;
  socket: WebSocket;
  pending: Map<string, {
    command: NodeCapability;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    cleanup: () => void;
  }>;
  streams: Map<string, {
    onData: (event: NodeStreamEvent) => void;
    onClose?: (error?: Error) => void;
    timeout?: NodeJS.Timeout;
  }>;
  transfers: Map<string, TransferState>;
  lastPongAt: number;
  lastPingAt: number;
  backpressure: NodeReadBackpressure;
};

type TransferState = {
  direction: "upload" | "download";
  ready: (message: NodeTransferReadyMessage) => void;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  stream?: PassThrough;
  source?: Readable;
  hash?: ReturnType<typeof createHash>;
  received?: number;
  maxBytes?: number;
};

export type BinaryDownloadResult = { filename: string; size?: number; stream: Readable };

export class PanelNodeConnections {
  private readonly connected = new Map<string, ConnectedNode>();
  private heartbeat: NodeJS.Timeout | undefined;

  connect(node: ManagedNode, socket: WebSocket) {
    const previous = this.connected.get(node.id);
    this.disconnect(node.id);
    if (previous && previous.socket.readyState === previous.socket.OPEN) previous.socket.close(4000, "Replaced by a newer node session");
    const connectedAt = Date.now();
    const backpressure = new NodeReadBackpressure(socket, () => { connected.lastPongAt = Date.now(); });
    const connected: ConnectedNode = { node, socket, pending: new Map(), streams: new Map(), transfers: new Map(), lastPongAt: connectedAt, lastPingAt: connectedAt, backpressure };
    this.connected.set(node.id, connected);
    socket.on("message", (raw, isBinary) => {
      // A replaced socket can still deliver buffered frames while its close handshake finishes.
      if (this.connected.get(node.id) !== connected) return;
      const buffer = Array.isArray(raw) ? Buffer.concat(raw) : Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      this.onMessage(node.id, buffer, isBinary);
    });
    socket.on("pong", () => { connected.lastPongAt = Date.now(); });
    socket.on("close", () => this.disconnect(node.id, socket));
    socket.on("error", () => this.disconnect(node.id, socket));
    this.startHeartbeat();
  }

  disconnect(nodeId: string, socket?: WebSocket) {
    const connected = this.connected.get(nodeId);
    if (!connected) return;
    if (socket && connected.socket !== socket) return;
    this.connected.delete(nodeId);
    for (const pending of connected.pending.values()) {
      pending.cleanup();
      pending.reject(structuredNodeProtocolError("node_offline", `Node ${connected.node.name} disconnected before ${pending.command} completed`));
    }
    connected.pending.clear();
    for (const stream of connected.streams.values()) {
      if (stream.timeout) clearTimeout(stream.timeout);
      const error = structuredNodeProtocolError("node_offline", `Node ${connected.node.name} disconnected during stream`);
      stream.onClose?.(error);
    }
    connected.streams.clear();
    for (const transfer of connected.transfers.values()) {
      clearTimeout(transfer.timeout);
      const error = structuredNodeProtocolError("node_offline", `Node ${connected.node.name} disconnected during transfer`);
      transfer.stream?.destroy(error);
      transfer.source?.destroy(error);
      transfer.reject(error);
    }
    connected.transfers.clear();
  }

  isConnected(nodeId: string) {
    const connected = this.connected.get(nodeId);
    return Boolean(connected && connected.socket.readyState === connected.socket.OPEN);
  }

  connectedNode(nodeId: string) {
    const connected = this.connected.get(nodeId);
    return connected && connected.socket.readyState === connected.socket.OPEN ? connected.node : undefined;
  }

  close() {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const [nodeId, connected] of Array.from(this.connected.entries())) {
      this.disconnect(nodeId);
      connected.socket.terminate();
    }
  }

  async request(node: ManagedNode, command: NodeCapability, payload?: unknown, timeoutMs = 15000, signal?: AbortSignal) {
    if (signal?.aborted) throw structuredNodeProtocolError("command_cancelled", `Node command ${command} was cancelled`);
    const connected = this.connected.get(node.id);
    if (!connected || connected.socket.readyState !== connected.socket.OPEN) {
      throw structuredNodeProtocolError("node_offline", `Node ${node.name} is offline`);
    }
    assertNodeSupports(connected.node, requireNodeCapability(command));
    if (connected.pending.size >= nodeProtocolMaxActiveRequests) {
      throw structuredNodeProtocolError("node_overloaded", `Node ${node.name} already has ${nodeProtocolMaxActiveRequests} active commands`);
    }

    const id = randomUUID();
    const message: NodeRequestMessage = {
      type: "request",
      id,
      command,
      payload,
      deadlineMs: nodeAdvertisesFeature(connected.node, "request-cancel") ? timeoutMs : undefined
    };
    const serialized = JSON.stringify(message);
    if (connected.node.protocolVersion === nodeProtocolVersion && Buffer.byteLength(serialized) > nodeProtocolControlMessageMaxBytes) {
      throw structuredNodeProtocolError("message_too_large", "Protocol 3.1 control messages are limited to 8 MiB; use a streamed transfer");
    }
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", onAbort);
        connected.pending.delete(id);
      };
      const cancel = (code: string, reason: string) => {
        if (!connected.pending.has(id)) return;
        cleanup();
        if (nodeAdvertisesFeature(connected.node, "request-cancel") && connected.socket.readyState === connected.socket.OPEN) {
          const message: NodeCancelMessage = { type: "cancel", id, reason };
          void this.send(connected.socket, JSON.stringify(message)).catch(() => undefined);
        }
        reject(structuredNodeProtocolError(code, reason));
      };
      const onAbort = () => cancel("command_cancelled", `Node command ${command} was cancelled`);
      const timeout = setTimeout(() => cancel("command_timeout", `Node command ${command} timed out`), timeoutMs);
      timeout.unref?.();
      connected.pending.set(id, { command, resolve, reject, cleanup });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      void this.send(connected.socket, serialized).catch((error) => {
        cleanup();
        reject(structuredNodeProtocolError("command_failed", error.message));
      });
    });
  }

  async stream(
    node: ManagedNode,
    command: NodeCapability,
    payload: unknown,
    onData: (event: NodeStreamEvent) => void,
    onClose?: (error?: Error) => void,
    timeoutMs?: number
  ) {
    const connected = this.connected.get(node.id);
    if (!connected || connected.socket.readyState !== connected.socket.OPEN) {
      throw structuredNodeProtocolError("node_offline", `Node ${node.name} is offline`);
    }
    assertNodeSupports(connected.node, requireNodeCapability(command));
    if (connected.streams.size >= nodeProtocolMaxActiveStreams) {
      throw structuredNodeProtocolError("node_overloaded", `Node ${node.name} already has ${nodeProtocolMaxActiveStreams} active streams`);
    }

    const id = randomUUID();
    const message: NodeStreamStartMessage = { type: "streamStart", id, command, payload };
    const serialized = JSON.stringify(message);
    if (connected.node.protocolVersion === nodeProtocolVersion && Buffer.byteLength(serialized) > nodeProtocolControlMessageMaxBytes) {
      throw structuredNodeProtocolError("message_too_large", "Protocol 3.1 control messages are limited to 8 MiB; use a streamed transfer");
    }
    return new Promise<() => void>((resolve, reject) => {
      const timeout = timeoutMs === undefined ? undefined : setTimeout(() => {
        const current = this.connected.get(node.id);
        const stream = current?.streams.get(id);
        if (!current || !stream) return;
        current.streams.delete(id);
        if (current.socket.readyState === current.socket.OPEN) {
          const stop: NodeStreamStopMessage = { type: "streamStop", id };
          void this.send(current.socket, JSON.stringify(stop)).catch(() => undefined);
        }
        stream.onClose?.(structuredNodeProtocolError("stream_timeout", `Node stream ${command} timed out`));
      }, timeoutMs);
      timeout?.unref?.();
      connected.streams.set(id, { onData, onClose, timeout });
      const cleanup = () => {
        const current = this.connected.get(node.id);
        const stream = current?.streams.get(id);
        if (!current || !stream) return;
        current.streams.delete(id);
        if (stream.timeout) clearTimeout(stream.timeout);
        if (current.socket.readyState === current.socket.OPEN) {
          const stop: NodeStreamStopMessage = { type: "streamStop", id };
          void this.send(current.socket, JSON.stringify(stop)).catch(() => undefined);
        }
      };
      void this.send(connected.socket, serialized).then(() => {
        resolve(cleanup);
      }, (error) => {
        if (timeout) clearTimeout(timeout);
        connected.streams.delete(id);
        reject(structuredNodeProtocolError("stream_failed", error.message));
      });
    });
  }

  async upload(
    node: ManagedNode,
    command: Extract<NodeTransferStartMessage["command"], "files.upload" | "mods.upload" | "content.upload">,
    payload: unknown,
    source: Readable,
    size: number,
    timeoutMs = 2 * 60 * 1000
  ) {
    const connected = this.transferConnection(node, command);
    const id = randomUUID();
    let readyResolve!: (message: NodeTransferReadyMessage) => void;
    const ready = new Promise<NodeTransferReadyMessage>((resolve) => { readyResolve = resolve; });
    let resultResolve!: (value: unknown) => void;
    let resultReject!: (error: Error) => void;
    const result = new Promise<unknown>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    const timeout = this.transferTimeout(connected, id, command, timeoutMs, resultReject);
    connected.transfers.set(id, { direction: "upload", ready: readyResolve, resolve: resultResolve, reject: resultReject, timeout, source });
    const start: NodeTransferStartMessage = { type: "transferStart", id, direction: "upload", command, payload, size };
    try {
      await this.send(connected.socket, JSON.stringify(start));
      await Promise.race([ready, result.then(() => { throw new Error("Transfer completed before it became ready"); })]);
      const observed = await sendTransferBody(source, id, size, (frame) => this.send(connected.socket, frame, true));
      if (observed.size !== size) throw new Error(`Upload declared ${size} bytes but streamed ${observed.size}`);
      const finish: NodeTransferFinishMessage = { type: "transferFinish", id, ...observed };
      await this.send(connected.socket, JSON.stringify(finish));
      return await result;
    } catch (error) {
      this.cancelTransfer(connected, id, (error as Error).message);
      source.destroy(error as Error);
      throw error;
    }
  }

  async download(
    node: ManagedNode,
    command: Extract<NodeTransferStartMessage["command"], "files.download" | "exports.download">,
    payload: unknown,
    maxBytes: number,
    timeoutMs = 2 * 60 * 1000,
    requireSize = true
  ): Promise<BinaryDownloadResult> {
    const connected = this.transferConnection(node, command);
    const id = randomUUID();
    const stream = new PassThrough();
    // `destroy(error)` on a stream nobody listens to is an unhandled 'error' event, which exits the
    // process. This one can fail before any consumer has seen it -- a node dropping mid-transfer
    // destroys it from `disconnect` -- so a node blip during a large export used to take the panel
    // down and leave the operation reading "did not complete before serverSENTINEL restarted".
    // The listener is additive: consumers that do handle errors still receive them.
    stream.on("error", () => {});
    // A consumer that abandons the download never drains it, so a socket paused for backpressure
    // would stay paused for the rest of the session.
    stream.once("close", () => {
      connected.backpressure.resume(stream);
      if (connected.transfers.has(id)) this.cancelTransfer(connected, id, "Download consumer closed");
    });
    let readyResolve!: (message: NodeTransferReadyMessage) => void;
    const ready = new Promise<NodeTransferReadyMessage>((resolve) => { readyResolve = resolve; });
    let resultResolve!: (value: unknown) => void;
    let resultReject!: (error: Error) => void;
    const result = new Promise<unknown>((resolve, reject) => { resultResolve = resolve; resultReject = reject; });
    void result.catch((error) => stream.destroy(error));
    const timeout = this.transferTimeout(connected, id, command, timeoutMs, resultReject);
    connected.transfers.set(id, { direction: "download", ready: readyResolve, resolve: resultResolve, reject: resultReject, timeout, stream, hash: createHash("sha256"), received: 0, maxBytes });
    const start: NodeTransferStartMessage = { type: "transferStart", id, direction: "download", command, payload, maxBytes };
    try {
      await this.send(connected.socket, JSON.stringify(start));
      const metadata = await Promise.race([ready, result.then(() => { throw new Error("Transfer completed before it became ready"); })]);
      if ((requireSize && metadata.size === undefined) || !metadata.filename) throw new Error("Node omitted transfer metadata");
      if (metadata.size !== undefined && metadata.size > maxBytes) throw new Error("Remote file exceeds the configured download limit");
      return { filename: metadata.filename, size: metadata.size, stream };
    } catch (error) {
      this.cancelTransfer(connected, id, (error as Error).message);
      throw error;
    }
  }

  private onMessage(nodeId: string, raw: Buffer, isBinary: boolean) {
    const connected = this.connected.get(nodeId);
    if (!connected) return;
    if (isBinary) {
      try {
        const { id, payload } = decodeTransferChunk(raw);
        const transfer = connected.transfers.get(id);
        if (!transfer || transfer.direction !== "download" || !transfer.stream || !transfer.hash) return;
        transfer.received = (transfer.received ?? 0) + payload.byteLength;
        if (transfer.received > (transfer.maxBytes ?? 0)) throw new Error("Remote transfer exceeded its limit");
        transfer.hash.update(payload);
        // A node can push chunks faster than the HTTP client drains them. `write` returning false means
        // the PassThrough is over its high-water mark, so stop reading the node socket until it drains
        // instead of letting the difference accumulate in panel memory.
        if (!transfer.stream.write(payload) && connected.backpressure.pause(transfer.stream)) {
          transfer.stream.once("drain", () => connected.backpressure.resume(transfer.stream!));
        }
      } catch (error) {
        connected.socket.close(1002, "Invalid binary transfer frame");
      }
      return;
    }
    if (raw.byteLength > nodeProtocolControlMessageMaxBytes) {
      connected.socket.close(1009, "Node protocol control message is too large");
      return;
    }
    let message: NodeResponseMessage | NodeStreamDataMessage | NodeStreamEndMessage | NodeTransferReadyMessage | NodeTransferFinishMessage | NodeTransferResultMessage | NodeTransferCancelMessage;
    try {
      message = normalizeNodeToPanelMessage(JSON.parse(raw.toString())) as typeof message;
    } catch {
      if (connected.node.protocolVersion === nodeProtocolVersion) connected.socket.close(1002, "Invalid node protocol message");
      return;
    }
    if (message.type === "transferReady") {
      connected.transfers.get(message.id)?.ready(message);
      return;
    }
    if (message.type === "transferFinish") {
      const transfer = connected.transfers.get(message.id);
      if (!transfer || transfer.direction !== "download" || !transfer.hash || !transfer.stream) return;
      const actualHash = transfer.hash.digest("hex");
      const actualSize = transfer.received ?? 0;
      const ok = actualSize === message.size && actualHash === message.sha256;
      connected.socket.send(JSON.stringify({ type: "transferResult", id: message.id, ok, error: ok ? undefined : { code: "transfer_integrity_failed", message: "Transfer size or SHA-256 did not match" } } satisfies NodeTransferResultMessage));
      clearTimeout(transfer.timeout);
      connected.transfers.delete(message.id);
      if (ok) {
        transfer.stream.end();
        transfer.resolve({ ok: true });
      } else {
        const error = structuredNodeProtocolError("transfer_integrity_failed", "Transfer size or SHA-256 did not match");
        transfer.stream.destroy(error);
        transfer.reject(error);
      }
      return;
    }
    if (message.type === "transferResult") {
      const transfer = connected.transfers.get(message.id);
      if (!transfer) return;
      clearTimeout(transfer.timeout);
      connected.transfers.delete(message.id);
      if (message.ok && transfer.direction === "download") {
        const error = structuredNodeProtocolError("unexpected_transfer_result", "Node completed a download without transfer integrity metadata");
        transfer.stream?.destroy(error);
        transfer.reject(error);
      } else if (message.ok) transfer.resolve(message.result);
      else transfer.reject(structuredNodeProtocolError(message.error?.code ?? "transfer_failed", message.error?.message ?? "Node transfer failed", message.error?.details, message.error?.retryable));
      return;
    }
    if (message.type === "transferCancel") {
      const transfer = connected.transfers.get(message.id);
      if (!transfer) return;
      clearTimeout(transfer.timeout);
      connected.transfers.delete(message.id);
      const error = structuredNodeProtocolError("transfer_cancelled", message.reason ?? "Node cancelled the transfer");
      transfer.stream?.destroy(error);
      transfer.source?.destroy(error);
      transfer.reject(error);
      return;
    }
    if (message.type === "streamData") {
      const stream = connected.streams.get(message.id);
      if (stream) stream.onData(message.event);
      return;
    }
    if (message.type === "streamEnd") {
      const stream = connected.streams.get(message.id);
      if (!stream) return;
      connected.streams.delete(message.id);
      if (stream.timeout) clearTimeout(stream.timeout);
      stream.onClose?.(message.error ? structuredNodeProtocolError(message.error.code, message.error.message, message.error.details, message.error.retryable) : undefined);
      return;
    }
    if (message.type !== "response") return;
    const pending = connected.pending.get(message.id);
    if (!pending) return;
    pending.cleanup();
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(structuredNodeProtocolError(message.error?.code ?? "command_failed", message.error?.message ?? "Node command failed", message.error?.details, message.error?.retryable));
  }

  private transferConnection(node: ManagedNode, command: NodeCapability) {
    const connected = this.connected.get(node.id);
    if (!connected || connected.socket.readyState !== connected.socket.OPEN) throw structuredNodeProtocolError("node_offline", `Node ${node.name} is offline`);
    assertNodeSupports(connected.node, requireNodeCapability(command));
    if (!nodeAdvertisesFeature(connected.node, "binary-transfer")) throw structuredNodeProtocolError("missing_feature", `Node ${node.name} does not support streamed binary transfers`);
    if (connected.transfers.size >= nodeProtocolMaxActiveTransfers) throw structuredNodeProtocolError("node_overloaded", `Node ${node.name} already has ${nodeProtocolMaxActiveTransfers} active transfers`);
    return connected;
  }

  private transferTimeout(connected: ConnectedNode, id: string, command: string, timeoutMs: number, reject: (error: Error) => void) {
    const timeout = setTimeout(() => {
      const transfer = connected.transfers.get(id);
      connected.transfers.delete(id);
      const error = structuredNodeProtocolError("transfer_timeout", `Node transfer ${command} timed out`);
      transfer?.stream?.destroy(error);
      transfer?.source?.destroy(error);
      if (connected.socket.readyState === connected.socket.OPEN) connected.socket.send(JSON.stringify({ type: "transferCancel", id, reason: `${command} timed out` }));
      reject(error);
    }, timeoutMs);
    timeout.unref?.();
    return timeout;
  }

  private cancelTransfer(connected: ConnectedNode, id: string, reason: string) {
    const transfer = connected.transfers.get(id);
    if (!transfer) return;
    clearTimeout(transfer.timeout);
    connected.transfers.delete(id);
    transfer.stream?.destroy();
    transfer.source?.destroy();
    if (connected.socket.readyState === connected.socket.OPEN) connected.socket.send(JSON.stringify({ type: "transferCancel", id, reason }));
  }

  private send(socket: WebSocket, payload: string | Buffer, binary = false) {
    return new Promise<void>((resolve, reject) => socket.send(payload, { binary }, (error) => error ? reject(error) : resolve()));
  }

  private startHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const now = Date.now();
      for (const [nodeId, connected] of this.connected) {
        // A socket paused for backpressure delivers no frames at all, pongs included, and a large
        // export can hold that pause open for longer than the timeout. The pong clock describes the
        // panel's own consumer there, not the node, so only the readyState check applies. Pings keep
        // going out either way, which is what the node's own watchdog measures.
        const stalePong = !connected.backpressure.paused && now - connected.lastPongAt >= heartbeatTimeoutMs;
        if (connected.socket.readyState !== connected.socket.OPEN || stalePong) {
          connected.socket.terminate();
          this.disconnect(nodeId, connected.socket);
          continue;
        }
        if (now - connected.lastPingAt >= heartbeatIntervalMs) {
          connected.lastPingAt = now;
          connected.socket.ping();
        }
      }
      if (this.connected.size === 0 && this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = undefined;
      }
    }, heartbeatCheckMs);
    this.heartbeat.unref?.();
  }
}
