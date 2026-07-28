import { throwHttp } from "../http/errors.js";
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
    throwHttp(400, `Remote node runtime is unavailable for node ${nodeId}`, { code: "node_runtime_unavailable" });
  }

  forServer(server: ManagedServer): NodeRuntime {
    return this.forNodeId(server.nodeId);
  }
}
