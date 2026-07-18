import type { ManagedServer } from "../types.js";
import type { NodeRuntime } from "./types.js";

export type LocalNodeRuntimeHandlers = Omit<NodeRuntime, "nodeId" | "updateServer"> & {
  updateServer(serverId: string, input: unknown): Promise<ManagedServer>;
};

export interface LocalNodeRuntime extends Omit<LocalNodeRuntimeHandlers, "updateServer"> {}

/**
 * Adapts the panel's local handlers to the same interface used by remote nodes.
 * Every handler already has the NodeRuntime signature except updateServer,
 * whose local implementation accepts a server ID.
 */
export class LocalNodeRuntime implements NodeRuntime {
  readonly nodeId = "local";
  private readonly updateServerById: LocalNodeRuntimeHandlers["updateServer"];

  constructor(handlers: LocalNodeRuntimeHandlers) {
    const { updateServer, ...delegates } = handlers;
    this.updateServerById = updateServer;
    Object.assign(this, delegates);
  }

  updateServer(server: ManagedServer, input: unknown) {
    return this.updateServerById(server.id, input);
  }
}
