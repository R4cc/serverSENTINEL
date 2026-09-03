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
  return {
    id: `server-${index}`, nodeId: "node-1", displayName: `Server ${index}`, serverDir: `/servers/${index}`,
    runtimeProfile: {
      minecraftVersion: "1.21.4", runtimeType: "fabric", runtimeVersion: "0.16.10", javaMajorVersion: 21,
      jarProvider: "mcjars", jarArtifact: { filename: "fabric-server-launch.jar" },
      compatibilityStatus: "compatible", resolvedAt: "2026-01-01T00:00:00.000Z"
    },
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  };
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

  it("carries overviewFiles on the background tick only for servers an overview consumer asked about", async () => {
    const servers = [server(0), server(1)];
    const calls: Array<Array<{ serverId: string; sections: string[] }>> = [];
    const connections = {
      isConnected: () => true,
      request: async (_node: ManagedNode, _command: string, payload: { items: Array<{ server: ManagedServer; sections: string[] }> }) => {
        calls.push(payload.items.map((item) => ({ serverId: item.server.id, sections: item.sections })));
        return {
          observedAt: new Date().toISOString(),
          items: payload.items.map(({ server: observed, sections }) => ({
            serverId: observed.id,
            ...(sections.includes("status") ? { status: { docker: { running: true } } } : {}),
            ...(sections.includes("overviewFiles") ? { overviewFiles: { properties: "level-name=world", eula: "eula=true" } } : {})
          }))
        };
      }
    } as unknown as PanelNodeConnections;
    const coordinator = new RemoteObservationCoordinator({ readServers: async () => servers, lookupNode: async () => node(), connections, pollMs: 60_000 });
    coordinator.start();
    for (let attempt = 0; attempt < 20 && calls.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(calls[0].every((item) => !item.sections.includes("overviewFiles"))).toBe(true);

    // The first overview read misses and fetches on its own; that registers the interest.
    await coordinator.readMany(servers[0], ["status", "overviewFiles"], 11_000);

    // `overviewFiles` rides the slow tick alongside players and logs, so drive ticks until one lands.
    const collectAll = (coordinator as unknown as { collectAll: () => Promise<void> }).collectAll.bind(coordinator);
    calls.length = 0;
    await collectAll();
    await collectAll();
    const tick = calls.find((items) => items.some((item) => item.sections.includes("players")));

    expect(tick?.find((item) => item.serverId === "server-0")?.sections).toContain("overviewFiles");
    expect(tick?.find((item) => item.serverId === "server-1")?.sections).not.toContain("overviewFiles");
    coordinator.stop();
  });

  it("resolves each node once per tick instead of once per server", async () => {
    const servers = Array.from({ length: 12 }, (_, index) => server(index));
    let lookups = 0;
    const connections = {
      isConnected: () => true,
      request: async (_node: ManagedNode, _command: string, payload: { items: Array<{ server: ManagedServer }> }) => ({
        observedAt: new Date().toISOString(),
        items: payload.items.map(({ server: observed }) => ({ serverId: observed.id, status: {} }))
      })
    } as unknown as PanelNodeConnections;
    const coordinator = new RemoteObservationCoordinator({
      readServers: async () => servers,
      lookupNode: async () => { lookups += 1; return node(); },
      connections,
      pollMs: 60_000
    });
    coordinator.start();
    for (let attempt = 0; attempt < 20 && lookups === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    // One lookup to group the fleet, one inside observeNode to address the batch.
    expect(lookups).toBeLessThanOrEqual(2);
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

  it("coalesces overlapping refreshes for the same node", async () => {
    const servers = [server(0)];
    const delays = [40, 0];
    const counters = [100, 500];
    let issued = 0;
    const connections = {
      isConnected: () => true,
      request: async (_node: ManagedNode, _command: string, payload: { items: Array<{ server: ManagedServer }> }) => {
        const attempt = issued;
        issued += 1;
        await new Promise((resolve) => setTimeout(resolve, delays[attempt] ?? 0));
        return {
          observedAt: new Date().toISOString(),
          items: payload.items.map(({ server: observed }) => ({ serverId: observed.id, stats: { networkRxBytes: counters[attempt] } }))
        };
      }
    } as unknown as PanelNodeConnections;
    const coordinator = new RemoteObservationCoordinator({ readServers: async () => servers, lookupNode: async () => node(), connections, pollMs: 60_000 });

    const slow = coordinator.refreshNode("node-1");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await coordinator.refreshNode("node-1");
    await slow;

    expect(issued).toBe(1);
    expect(await coordinator.read(servers[0], "stats", 60_000)).toEqual({ networkRxBytes: 100 });
    coordinator.stop();
  });

  it("prioritizes a foreground read over a slow fleet observation", async () => {
    const servers = [server(0), server(1)];
    let issued = 0;
    let releaseBackground!: () => void;
    const backgroundBlocked = new Promise<void>((resolve) => { releaseBackground = resolve; });
    const connections = {
      isConnected: () => true,
      request: async (_node: ManagedNode, _command: string, payload: { items: Array<{ server: ManagedServer }> }) => {
        const attempt = issued;
        issued += 1;
        if (attempt === 0) await backgroundBlocked;
        return {
          observedAt: new Date().toISOString(),
          items: payload.items.map(({ server: observed }) => ({
            serverId: observed.id,
            status: { docker: { running: attempt > 0 } }
          }))
        };
      }
    } as unknown as PanelNodeConnections;
    const coordinator = new RemoteObservationCoordinator({ readServers: async () => servers, lookupNode: async () => node(), connections, pollMs: 60_000 });

    const background = coordinator.refreshNode("node-1");
    for (let attempt = 0; attempt < 20 && issued === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 1));

    await expect(coordinator.read(servers[0], "status", 60_000)).resolves.toEqual({ docker: { running: true } });
    expect(issued).toBe(2);

    releaseBackground();
    await background;
    await expect(coordinator.read(servers[0], "status", 60_000)).resolves.toEqual({ docker: { running: true } });
    coordinator.stop();
  });

  it("rejects a failed section instead of returning an old confirmed value", async () => {
    const observedServer = server(0);
    let requestCount = 0;
    const connections = {
      isConnected: () => true,
      request: async () => {
        requestCount += 1;
        return requestCount === 1
          ? { observedAt: new Date().toISOString(), items: [{ serverId: observedServer.id, status: { docker: { running: true } } }] }
          : { observedAt: new Date().toISOString(), items: [{ serverId: observedServer.id, errors: { status: { code: "docker_unavailable", message: "Docker did not respond", retryable: true } } }] };
      }
    } as unknown as PanelNodeConnections;
    const coordinator = new RemoteObservationCoordinator({ readServers: async () => [observedServer], lookupNode: async () => node(), connections });

    await expect(coordinator.read(observedServer, "status", 60_000)).resolves.toEqual({ docker: { running: true } });
    await new Promise((resolve) => setTimeout(resolve, 5));
    await expect(coordinator.read(observedServer, "status", 1)).rejects.toMatchObject({
      code: "docker_unavailable",
      retryable: true
    });
    coordinator.stop();
  });

  it("rejects an observation batch that names an unrequested server", async () => {
    const observedServer = server(0);
    const connections = {
      isConnected: () => true,
      request: async () => ({
        observedAt: new Date().toISOString(),
        items: [{ serverId: "server-sibling", status: { docker: { running: true } } }]
      })
    } as unknown as PanelNodeConnections;
    const coordinator = new RemoteObservationCoordinator({ readServers: async () => [observedServer], lookupNode: async () => node(), connections });

    await expect(coordinator.read(observedServer, "status", 0)).rejects.toMatchObject({ code: "invalid_observation_response" });
    coordinator.stop();
  });
});
