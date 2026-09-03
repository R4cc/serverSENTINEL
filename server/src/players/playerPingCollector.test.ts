import { describe, expect, it, vi } from "vitest";
import type { PlayerSnapshot } from "@serversentinel/contracts";
import type { ManagedServer } from "../types.js";
import { playerGeoKey } from "../storage/playerGeoRepository.js";
import type { PlayerConnectionObservation } from "./dockerPlayerConnections.js";
import { normalizeConnectionAddress, PlayerPingCollector } from "./playerPingCollector.js";

const server = { id: "server-1", displayName: "Survival" } as ManagedServer;

function online(...names: string[]): PlayerSnapshot {
  return { state: "live", names, online: names.length, maxPlayers: 20, sampledAt: "2026-09-02T12:00:00.000Z" };
}

async function collectorFixture() {
  let snapshot = online("Alex", "Steve");
  let observation: PlayerConnectionObservation = {
    status: "available",
    instanceId: "container-1",
    connections: []
  };
  let enabled = false;
  let now = Date.parse("2026-09-02T12:00:00.000Z");
  const errors: unknown[] = [];
  const averages: Array<{ playerKey: string; averagePingMs: number; samples: number; at: number }> = [];
  const collector = new PlayerPingCollector({
    readServers: async () => enabled ? [server] : [],
    snapshot: () => snapshot,
    readConnections: async () => observation,
    pollMs: 60_000,
    now: () => now,
    recordAverages: (_serverId, entries) => averages.push(...entries),
    onError: (error) => errors.push(error)
  });
  collector.start();
  await collector.collectAll();
  enabled = true;
  return {
    collector,
    errors,
    averages,
    setSnapshot(value: PlayerSnapshot) { snapshot = value; },
    setObservation(value: typeof observation) { observation = value; },
    setNow(value: number) { now = value; }
  };
}

describe("player ping collection", () => {
  it("normalizes IPv4, IPv6, and IPv4-mapped IPv6 for exact comparison", () => {
    expect(normalizeConnectionAddress("203.000.113.005")).toBe("203.0.113.5");
    expect(normalizeConnectionAddress("2001:db8::1")).toBe("2001:db8::1");
    expect(normalizeConnectionAddress("::ffff:203.0.113.5")).toBe("203.0.113.5");
    expect(normalizeConnectionAddress("not-an-address")).toBeUndefined();
  });

  it("matches players by address and source port without confusing NAT peers", async () => {
    const fixture = await collectorFixture();
    fixture.collector.observeLogin(server, { player: "Alex", address: "203.0.113.5", port: 50001 });
    fixture.collector.observeLogin(server, { player: "Steve", address: "203.0.113.5", port: 50002 });
    fixture.setObservation({
      status: "available", instanceId: "container-1",
      connections: [
        { remoteAddress: "::ffff:203.0.113.5", remotePort: 50002, rttUs: 81_400 },
        { remoteAddress: "203.0.113.5", remotePort: 50003, rttUs: 10_000 }
      ]
    });
    await fixture.collector.collectAll();

    expect(fixture.collector.latest(server.id).get(playerGeoKey("Alex"))).toBeUndefined();
    expect(fixture.collector.latest(server.id).get(playerGeoKey("Steve"))).toBe(81);
    expect(fixture.collector.measurements([server.id])[0]).toMatchObject({ status: "available", measuredPlayers: 1, onlinePlayers: 2 });
    fixture.collector.stop();
  });

  it("clears disconnected and reconnected players instead of retaining stale values", async () => {
    const fixture = await collectorFixture();
    fixture.collector.observeLogin(server, { player: "Alex", address: "2001:db8::1", port: 50100 });
    fixture.setObservation({
      status: "available", instanceId: "container-1",
      connections: [{ remoteAddress: "2001:0db8::1", remotePort: 50100, rttUs: 25_100 }]
    });
    await fixture.collector.collectAll();
    expect(fixture.collector.latest(server.id).get(playerGeoKey("Alex"))).toBe(25);

    fixture.collector.observeLogin(server, { player: "Alex", address: "2001:db8::1", port: 50101 });
    expect(fixture.collector.latest(server.id).has(playerGeoKey("Alex"))).toBe(false);

    fixture.collector.observeLogin(server, { player: "Alex", address: "2001:db8::1" });
    expect(fixture.collector.latest(server.id).has(playerGeoKey("Alex"))).toBe(false);

    fixture.setSnapshot(online("Steve"));
    await fixture.collector.collectAll();
    expect(fixture.collector.latest(server.id).has(playerGeoKey("Alex"))).toBe(false);

    fixture.setSnapshot(online("Alex"));
    await fixture.collector.collectAll();
    expect(fixture.collector.latest(server.id).has(playerGeoKey("Alex"))).toBe(false);
    fixture.collector.stop();
  });

  it("persists a rolling minute average and starts fresh on a newer login", async () => {
    const fixture = await collectorFixture();
    const start = Date.parse("2026-09-02T12:00:00.000Z");
    fixture.collector.observeLogin(server, { player: "Alex", address: "198.51.100.8", port: 50001, at: new Date(start).toISOString() });

    for (const [index, pingMs] of [10, 20, 30, 40, 50, 60, 70].entries()) {
      fixture.setNow(start + (index + 1) * 10_000);
      fixture.setObservation({
        status: "available",
        instanceId: "container-1",
        connections: [{ remoteAddress: "198.51.100.8", remotePort: 50001, rttUs: pingMs * 1_000 }]
      });
      await fixture.collector.collectAll();
    }

    expect(fixture.averages.at(-1)).toEqual({ playerKey: "alex", averagePingMs: 45, samples: 6, at: start + 70_000 });

    fixture.setNow(start + 200_000);
    fixture.setObservation({
      status: "available",
      instanceId: "container-1",
      connections: [{ remoteAddress: "198.51.100.8", remotePort: 50001, rttUs: 80_000 }]
    });
    await fixture.collector.collectAll();
    expect(fixture.averages.at(-1)).toEqual({ playerKey: "alex", averagePingMs: 80, samples: 1, at: start + 200_000 });

    fixture.collector.observeLogin(server, { player: "Alex", address: "198.51.100.8", port: 50001, at: new Date(start + 300_000).toISOString() });
    fixture.setNow(start + 310_000);
    fixture.setObservation({
      status: "available",
      instanceId: "container-1",
      connections: [{ remoteAddress: "198.51.100.8", remotePort: 50001, rttUs: 90_000 }]
    });
    await fixture.collector.collectAll();

    expect(fixture.averages.at(-1)).toEqual({ playerKey: "alex", averagePingMs: 90, samples: 1, at: start + 310_000 });
    fixture.collector.stop();
  });

  it("expires old readings and clears them for unsupported, failed, or changed containers", async () => {
    const fixture = await collectorFixture();
    fixture.collector.observeLogin(server, { player: "Alex", address: "198.51.100.4", port: 50001 });
    fixture.setObservation({
      status: "available", instanceId: "container-1",
      connections: [{ remoteAddress: "198.51.100.4", remotePort: 50001, rttUs: 40_000 }]
    });
    await fixture.collector.collectAll();
    fixture.setNow(Date.parse("2026-09-02T12:00:16.000Z"));
    expect(fixture.collector.latest(server.id).size).toBe(0);

    fixture.setObservation({ status: "unsupported", connections: [] });
    await fixture.collector.collectAll();
    expect(fixture.collector.measurements([server.id])[0]).toEqual(expect.objectContaining({ status: "unsupported", measuredPlayers: 0 }));

    fixture.setObservation({
      status: "available", instanceId: "container-2",
      connections: [{ remoteAddress: "198.51.100.4", remotePort: 50001, rttUs: 9_000 }]
    });
    await fixture.collector.collectAll();
    expect(fixture.collector.latest(server.id).size).toBe(0);
    fixture.collector.stop();
  });

  it("turns probe failures into a safe unavailable state and clears all memory on stop", async () => {
    const fixture = await collectorFixture();
    const failure = new Error("socket 203.0.113.9:50000 denied");
    const reader = vi.spyOn((fixture.collector as unknown as { options: { readConnections: () => Promise<never> } }).options, "readConnections")
      .mockRejectedValue(failure);
    await fixture.collector.collectAll();

    expect(reader).toHaveBeenCalled();
    expect(fixture.errors).toHaveLength(1);
    expect((fixture.errors[0] as Error).message).toBe("Player ping measurement failed");
    expect(fixture.collector.measurements([server.id])[0]).toEqual(expect.objectContaining({ status: "unavailable" }));
    expect(JSON.stringify(fixture.collector.measurements([server.id]))).not.toContain("203.0.113.9");
    fixture.collector.stop();
    expect(fixture.collector.latest(server.id).size).toBe(0);
    expect(fixture.collector.measurements([server.id])[0].status).toBe("idle");
  });
});
