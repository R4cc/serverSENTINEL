import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { ManagedNode } from "../types.js";
import { assertNodeSupports, requireNodeCapability, structuredNodeProtocolError } from "./protocol.js";
import type { NodeCapability, NodeRequestMessage, NodeResponseMessage, NodeStreamDataMessage, NodeStreamEndMessage, NodeStreamEvent, NodeStreamStartMessage, NodeStreamStopMessage } from "./protocol.js";

type ConnectedNode = {
  node: ManagedNode;
  socket: WebSocket;
  pending: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>;
  streams: Map<string, {
    onData: (event: NodeStreamEvent) => void;
    onClose?: (error?: Error) => void;
  }>;
};

export class PanelNodeConnections {
  private readonly connected = new Map<string, ConnectedNode>();

  connect(node: ManagedNode, socket: WebSocket) {
    this.disconnect(node.id);
    const connected: ConnectedNode = { node, socket, pending: new Map(), streams: new Map() };
    this.connected.set(node.id, connected);
    socket.on("message", (raw) => this.onMessage(node.id, raw.toString()));
    socket.on("close", () => this.disconnect(node.id, socket));
    socket.on("error", () => this.disconnect(node.id, socket));
  }

  disconnect(nodeId: string, socket?: WebSocket) {
    const connected = this.connected.get(nodeId);
    if (!connected) return;
    if (socket && connected.socket !== socket) return;
    this.connected.delete(nodeId);
    for (const [id, pending] of connected.pending) {
      clearTimeout(pending.timeout);
      pending.reject(structuredNodeProtocolError("node_offline", `Node ${nodeId} disconnected before command ${id} completed`));
    }
    connected.pending.clear();
    for (const stream of connected.streams.values()) {
      stream.onData({ type: "unavailable", message: "Node disconnected" });
      stream.onClose?.();
    }
    connected.streams.clear();
  }

  isConnected(nodeId: string) {
    return this.connected.has(nodeId);
  }

  async request(node: ManagedNode, command: NodeCapability, payload?: unknown, timeoutMs = 15000) {
    const connected = this.connected.get(node.id);
    if (!connected || connected.socket.readyState !== connected.socket.OPEN) {
      throw structuredNodeProtocolError("node_offline", `Node ${node.name} is offline`);
    }
    assertNodeSupports(node, requireNodeCapability(command));

    const id = randomUUID();
    const message: NodeRequestMessage = { type: "request", id, command, payload };
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        connected.pending.delete(id);
        reject(structuredNodeProtocolError("command_timeout", `Node command ${command} timed out`));
      }, timeoutMs);
      connected.pending.set(id, { resolve, reject, timeout });
      connected.socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        connected.pending.delete(id);
        reject(structuredNodeProtocolError("command_failed", error.message));
      });
    });
  }

  async stream(
    node: ManagedNode,
    command: NodeCapability,
    payload: unknown,
    onData: (event: NodeStreamEvent) => void,
    onClose?: (error?: Error) => void
  ) {
    const connected = this.connected.get(node.id);
    if (!connected || connected.socket.readyState !== connected.socket.OPEN) {
      throw structuredNodeProtocolError("node_offline", `Node ${node.name} is offline`);
    }
    assertNodeSupports(node, requireNodeCapability(command));

    const id = randomUUID();
    const message: NodeStreamStartMessage = { type: "streamStart", id, command, payload };
    return new Promise<() => void>((resolve, reject) => {
      connected.streams.set(id, { onData, onClose });
      const cleanup = () => {
        const current = this.connected.get(node.id);
        const stream = current?.streams.get(id);
        if (!current || !stream) return;
        current.streams.delete(id);
        if (current.socket.readyState === current.socket.OPEN) {
          const stop: NodeStreamStopMessage = { type: "streamStop", id };
          current.socket.send(JSON.stringify(stop));
        }
      };
      connected.socket.send(JSON.stringify(message), (error) => {
        if (!error) {
        resolve(cleanup);
          return;
        }
        connected.streams.delete(id);
        reject(structuredNodeProtocolError("stream_failed", error.message));
      });
    });
  }

  private onMessage(nodeId: string, raw: string) {
    const connected = this.connected.get(nodeId);
    if (!connected) return;
    let message: NodeResponseMessage | NodeStreamDataMessage | NodeStreamEndMessage;
    try {
      message = JSON.parse(raw) as NodeResponseMessage | NodeStreamDataMessage | NodeStreamEndMessage;
    } catch {
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
      stream.onClose?.(message.error ? structuredNodeProtocolError(message.error.code, message.error.message, message.error.details) : undefined);
      return;
    }
    if (message.type !== "response") return;
    const pending = connected.pending.get(message.id);
    if (!pending) return;
    connected.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(structuredNodeProtocolError(message.error?.code ?? "command_failed", message.error?.message ?? "Node command failed", message.error?.details));
  }
}
