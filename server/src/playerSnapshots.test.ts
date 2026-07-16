import { describe, expect, it, vi } from "vitest";
import type { ManagedServer } from "./types.js";
import type { NodeRuntime } from "./nodes/types.js";
import type { PlayerObservation } from "./playerSnapshots.js";
import { PlayerSnapshotCoordinator } from "./playerSnapshots.js";

const server = {
  id: "server-1",
  nodeId: "node-1",
  displayName: "Survival",
  serverDir: "/data/server-1",
  runtimeProfile: { loader: "fabric", javaMajorVersion: 21 },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
} as ManagedServer;

const live = (sampledAt: string, instanceId = "container:start-a"): PlayerObservation => ({
  state: "live",
  instanceId,
  online: 2,
  maxPlayers: 20,
  names: ["Alex", "Steve"],
  sampledAt
});

function coordinator(read: () => Promise<PlayerObservation>, now: () => number) {
  return new PlayerSnapshotCoordinator({
    pollMs: 10_000,
    staleMs: 5 * 60 * 1000,
    readServers: async () => [server],
    runtimeForServer: () => ({ readPlayerObservation: read } as NodeRuntime),
    now
  });
}

describe("player snapshot coordinator", () => {
  it("preserves one complete snapshot through a bounded transient failure", async () => {
    let timestamp = Date.parse("2026-07-16T12:00:00.000Z");
    const observations: PlayerObservation[] = [
      live(new Date(timestamp).toISOString()),
      {
        state: "unavailable",
        instanceId: "container:start-a",
        maxPlayers: 20,
        attemptedAt: "2026-07-16T12:00:10.000Z",
        code: "QUERY_TIMEOUT",
        message: "Minecraft Query timed out"
      }
    ];
    const snapshots = coordinator(async () => observations.shift()!, () => timestamp);

    await expect(snapshots.collect(server)).resolves.toMatchObject({ state: "live", online: 2, names: ["Alex", "Steve"] });
    timestamp += 10_000;
    await expect(snapshots.collect(server)).resolves.toMatchObject({
      state: "stale",
      online: 2,
      names: ["Alex", "Steve"],
      code: "QUERY_TIMEOUT"
    });
  });

  it("expires stale data and never reuses it for another container instance", async () => {
    let timestamp = Date.parse("2026-07-16T12:00:00.000Z");
    let observation: PlayerObservation = live(new Date(timestamp).toISOString());
    const snapshots = coordinator(async () => observation, () => timestamp);
    await snapshots.collect(server);

    timestamp += 5 * 60 * 1000 + 1;
    observation = {
      state: "unavailable",
      instanceId: "container:start-a",
      maxPlayers: 20,
      attemptedAt: new Date(timestamp).toISOString(),
      code: "QUERY_RESPONSE_INCOMPLETE",
      message: "Incomplete response"
    };
    await expect(snapshots.collect(server)).resolves.toMatchObject({ state: "unavailable", online: null });

    timestamp += 1;
    observation = live(new Date(timestamp).toISOString(), "container:start-b");
    await snapshots.collect(server);
    observation = {
      state: "unavailable",
      instanceId: "container:start-c",
      maxPlayers: 20,
      attemptedAt: new Date(timestamp + 1).toISOString(),
      code: "QUERY_TIMEOUT",
      message: "Timed out"
    };
    await expect(snapshots.collect(server)).resolves.toMatchObject({ state: "unavailable", online: null });
  });

  it("coalesces concurrent reads and requires live data for automation", async () => {
    const deferred = Promise.withResolvers<PlayerObservation>();
    const read = vi.fn(() => deferred.promise);
    const snapshots = coordinator(read, () => Date.parse("2026-07-16T12:00:00.000Z"));
    const first = snapshots.collect(server);
    const second = snapshots.collect(server);
    expect(read).toHaveBeenCalledTimes(1);
    deferred.resolve(live("2026-07-16T12:00:00.000Z"));
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);

    await expect(snapshots.freshOnlineCount(server)).resolves.toBe(2);
  });

  it("clears verified data when the server is confirmed stopped", async () => {
    let observation: PlayerObservation = live("2026-07-16T12:00:00.000Z");
    const snapshots = coordinator(async () => observation, () => Date.parse("2026-07-16T12:00:10.000Z"));
    await snapshots.collect(server);
    observation = { state: "stopped", instanceId: "container:start-a", maxPlayers: 20, sampledAt: "2026-07-16T12:00:10.000Z" };
    await expect(snapshots.collect(server)).resolves.toMatchObject({ state: "stopped", online: 0, names: [] });
  });
});
