import type { ManagedServer } from "../types.js";
import type { NodeRuntime } from "./types.js";

function remoteRuntimeNotImplemented(nodeId: string): never {
  const error = new Error(`Remote node runtime not implemented yet for node ${nodeId}`) as Error & { statusCode?: number };
  error.statusCode = 400;
  throw error;
}

export class NodeRuntimeRegistry {
  constructor(private readonly localRuntime: NodeRuntime) {}

  forNodeId(nodeId: string): NodeRuntime {
    if (nodeId === this.localRuntime.nodeId) {
      return this.localRuntime;
    }
    return remoteRuntimeNotImplemented(nodeId);
  }

  forServer(server: ManagedServer): NodeRuntime {
    return this.forNodeId(server.nodeId);
  }
}
