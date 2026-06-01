import { randomUUID } from "node:crypto";
import type WebSocket from "ws";
import type { ManagedNode } from "../types.js";
import { nodeCapabilities, protocolCompatible } from "./protocol.js";
import type { NodeCapability, NodeRequestMessage, NodeResponseMessage } from "./protocol.js";

type ConnectedNode = {
  node: ManagedNode;
  socket: WebSocket;
  pending: Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: NodeJS.Timeout;
  }>;
};

function structuredNodeError(code: string, message: string) {
  const error = new Error(message) as Error & { code?: string; statusCode?: number };
  error.code = code;
  error.statusCode = 400;
  return error;
}

export class PanelNodeConnections {
  private readonly connected = new Map<string, ConnectedNode>();

  connect(node: ManagedNode, socket: WebSocket) {
    this.disconnect(node.id);
    const connected: ConnectedNode = { node, socket, pending: new Map() };
    this.connected.set(node.id, connected);
    socket.on("message", (raw) => this.onMessage(node.id, raw.toString()));
    socket.on("close", () => this.disconnect(node.id));
    socket.on("error", () => this.disconnect(node.id));
  }

  disconnect(nodeId: string) {
    const connected = this.connected.get(nodeId);
    if (!connected) return;
    this.connected.delete(nodeId);
    for (const [id, pending] of connected.pending) {
      clearTimeout(pending.timeout);
      pending.reject(structuredNodeError("node_offline", `Node ${nodeId} disconnected before command ${id} completed`));
    }
    connected.pending.clear();
  }

  isConnected(nodeId: string) {
    return this.connected.has(nodeId);
  }

  async request(node: ManagedNode, command: NodeCapability, payload?: unknown, timeoutMs = 15000) {
    const connected = this.connected.get(node.id);
    if (!connected || connected.socket.readyState !== connected.socket.OPEN) {
      throw structuredNodeError("node_offline", `Node ${node.name} is offline`);
    }
    if (!protocolCompatible(node.protocolVersion)) {
      throw structuredNodeError("node_incompatible", `Node ${node.name} uses unsupported protocol ${node.protocolVersion ?? "unknown"}`);
    }
    if (!node.capabilities?.includes(command)) {
      throw structuredNodeError("missing_capability", `Node ${node.name} does not advertise ${command}`);
    }
    if (!nodeCapabilities.includes(command)) {
      throw structuredNodeError("missing_capability", `Command ${command} is not supported by this panel`);
    }

    const id = randomUUID();
    const message: NodeRequestMessage = { type: "request", id, command, payload };
    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        connected.pending.delete(id);
        reject(structuredNodeError("command_timeout", `Node command ${command} timed out`));
      }, timeoutMs);
      connected.pending.set(id, { resolve, reject, timeout });
      connected.socket.send(JSON.stringify(message), (error) => {
        if (!error) return;
        clearTimeout(timeout);
        connected.pending.delete(id);
        reject(structuredNodeError("command_failed", error.message));
      });
    });
  }

  private onMessage(nodeId: string, raw: string) {
    const connected = this.connected.get(nodeId);
    if (!connected) return;
    let message: NodeResponseMessage;
    try {
      message = JSON.parse(raw) as NodeResponseMessage;
    } catch {
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
    pending.reject(structuredNodeError(message.error?.code ?? "command_failed", message.error?.message ?? "Node command failed"));
  }
}
