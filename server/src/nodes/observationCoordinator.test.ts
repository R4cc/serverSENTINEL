import { describe, expect, it } from "vitest";
import type { ManagedNode, ManagedServer } from "../types.js";
import type { PanelNodeConnections } from "./panelConnections.js";
import { nodeCapabilities, nodeFeatures, nodeProtocolVersion } from "./protocol.js";
import { RemoteObservationCoordinator } from "./observationCoordinator.js";

function node(): ManagedNode {
  return {
    id: "node-1", name: "Node", type: "remote", status: "online", isInternal: false,
    protocolVersion: nodeProtocolVersion, capabilities: [...nodeCapabilities], features: [...nodeFeatures],
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function server(index: number): ManagedServer {
  return { id: `server-${index}`, nodeId: "node-1", displayName: `Server ${index}`, serverDir: `/servers/${index}`, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

describe("RemoteObservationCoordinator", () => {
  it("batches a node fleet into one shared observation and serves consumers from cache", async () => {
    const servers = Array.from({ length: 10 }, (_, index) => server(index));
    const calls: Array<{ items: Array<{ server: ManagedServer; sections: string[] }> }> = [];
    const connections = {
      isConnected: () => true,
      request: async (_node: ManagedNode, _command: string, payload: { items: Array<{ server: ManagedServer; sections: string[] }> }) => {
        calls.push(payload);
        return {
          observedAt: new Date().toISOString(),
          items: payload.items.map(({ server: observed }) => ({
            serverId: observed.id,
            status: { docker: { running: true } },
            stats: { cpuPercent: 1 },
            players: { state: "live", online: 0 },
            logs: { text: "", source: "logs/latest.log", reset: true }
          }))
        };
      }
    } as unknown as PanelNodeConnections;
    const coordinator = new RemoteObservationCoordinator({ readServers: async () => servers, lookupNode: async () => node(), connections, pollMs: 60_000 });
    coordinator.start();
    for (let attempt = 0; attempt < 20 && calls.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(calls).toHaveLength(1);
    expect(calls[0].items).toHaveLength(10);
    expect(calls[0].items[0].sections).toEqual(["status", "stats", "players", "logs"]);
    await expect(coordinator.read(servers[0], "status", 6_000)).resolves.toEqual({ docker: { running: true } });
    expect(calls).toHaveLength(1);
    coordinator.stop();
  });

  it("chunks fleets above the 32-server protocol bound", async () => {
    const servers = Array.from({ length: 33 }, (_, index) => server(index));
    const sizes: number[] = [];
    const connections = {
      isConnected: () => true,
      request: async (_node: ManagedNode, _command: string, payload: { items: Array<{ server: ManagedServer }> }) => {
        sizes.push(payload.items.length);
        return { observedAt: new Date().toISOString(), items: payload.items.map(({ server: observed }) => ({ serverId: observed.id, status: {} })) };
      }
    } as unknown as PanelNodeConnections;
    const coordinator = new RemoteObservationCoordinator({ readServers: async () => servers, lookupNode: async () => node(), connections, pollMs: 60_000 });
    coordinator.start();
    for (let attempt = 0; attempt < 20 && sizes.length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(sizes).toEqual([32, 1]);
    coordinator.stop();
  });
});
