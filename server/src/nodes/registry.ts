import type { ManagedServer } from "../types.js";
import type { NodeRuntime } from "./types.js";

export class NodeRuntimeRegistry {
  constructor(
    private readonly localRuntime: NodeRuntime | undefined,
    private readonly remoteRuntimeFactory?: (nodeId: string) => NodeRuntime
  ) {}

  forNodeId(nodeId: string): NodeRuntime {
    if (this.localRuntime && nodeId === this.localRuntime.nodeId) {
      return this.localRuntime;
    }
    if (this.remoteRuntimeFactory) {
      return this.remoteRuntimeFactory(nodeId);
    }
    const error = new Error(`Remote node runtime not implemented yet for node ${nodeId}`) as Error & { statusCode?: number; code?: string };
    error.statusCode = 400;
    error.code = "node_runtime_unavailable";
    throw error;
  }

  forServer(server: ManagedServer): NodeRuntime {
    return this.forNodeId(server.nodeId);
  }
}
