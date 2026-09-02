import { describe, expect, it } from "vitest";
import { greatCircleDistanceKm, quietestWindow, type PlayerActivityHour, type PlayerGeoDatabaseState, type PlayerLocation } from "@serversentinel/contracts";
import type { ResourceStatsSample } from "../resourceStatsCollector.js";
import type { StoredPlayerGeo } from "../storage/playerGeoRepository.js";
import type { ManagedServer, PlayerSnapshot } from "../types.js";
import { buildPlayerInsights, playerActivityHours, playerInsightsEntries, playerLatencyHistory, playerRegionSummaries } from "./playerInsights.js";

const now = Date.parse("2026-08-16T12:00:00.000Z");
const historyWindowMs = 7 * 24 * 60 * 60 * 1000;
const servers = [{ id: "server-1", displayName: "Survival" }, { id: "server-2", displayName: "Creative" }] as ManagedServer[];
const geoDatabase: PlayerGeoDatabaseState = { available: true, configured: true, updating: false };

function location(overrides: Partial<PlayerLocation> = {}): PlayerLocation {
  return { label: "Copenhagen", city: "Copenhagen", country: "Denmark", countryCode: "DK", continent: "Europe", continentCode: "EU", latitude: 55.68, longitude: 12.57, accuracyRadiusKm: 20, precision: "city", ...overrides };
}

function stored(player: string, serverId: string, overrides: Partial<PlayerLocation> = {}): StoredPlayerGeo {
  const firstSeenAt = now - 86_400_000;
  const place = location(overrides);
  return { serverId, player, playerKey: player.toLowerCase(), stints: [{ location: place, firstSeenAt, lastSeenAt: now - 60_000, observations: 3 }], location: place, firstSeenAt, lastSeenAt: now - 60_000, observations: 3 };
}

function liveSnapshot(names: string[]): PlayerSnapshot {
  return { state: "live", online: names.length, maxPlayers: 20, names, sampledAt: new Date(now).toISOString() };
}

function sample(sampledAt: number, playersOnline: number, playerPingMs?: number[]): ResourceStatsSample {
  return { available: true, running: true, cpuPercent: 1, memoryUsageBytes: 1, memoryLimitBytes: 2, readAt: new Date(sampledAt).toISOString(), sampledAt, playersOnline, ...(playerPingMs ? { playerPingMs } : {}) };
}

describe("player entries", () => {
  const serverLocations = [
    { serverId: "server-1", address: "play.example.net", location: location({ label: "Frankfurt", city: "Frankfurt", country: "Germany", countryCode: "DE", latitude: 50.11, longitude: 8.68 }) },
    { serverId: "server-2" }
  ];

  it("keeps geographic distance separate from measured ping", () => {
    const entries = playerInsightsEntries({ servers, snapshots: { "server-1": liveSnapshot(["SullyTheSnak"]) }, geo: [stored("SullyTheSnak", "server-1"), stored("EnderBobo", "server-2")], serverLocations, pings: { "server-1": new Map([["sullythesnak", 42]]) } });
    expect(entries.find((entry) => entry.player === "SullyTheSnak")).toMatchObject({ online: true, pingMs: 42 });
    expect(entries.find((entry) => entry.player === "SullyTheSnak")?.distanceKm).toBeGreaterThan(500);
    expect(entries.find((entry) => entry.player === "EnderBobo")?.pingMs).toBeUndefined();
  });

  it("never gives an offline player a stale ping", () => {
    const entries = playerInsightsEntries({ servers, snapshots: { "server-1": liveSnapshot([]) }, geo: [stored("SullyTheSnak", "server-1")], serverLocations, pings: { "server-1": new Map([["sullythesnak", 42]]) } });
    expect(entries[0]).toMatchObject({ online: false });
    expect(entries[0].pingMs).toBeUndefined();
  });

  it("adds an unlocated online player once and can still report measured ping", () => {
    const entries = playerInsightsEntries({ servers, snapshots: { "server-1": liveSnapshot(["Newcomer"]) }, geo: [], serverLocations, pings: { "server-1": new Map([["newcomer", 18]]) } });
    expect(entries).toEqual([expect.objectContaining({ player: "Newcomer", online: true, pingMs: 18, observations: 0 })]);
    expect(entries[0].location).toBeUndefined();
  });
});

describe("regional spread", () => {
  it("averages only measured online players", () => {
    const entries = playerInsightsEntries({
      servers,
      snapshots: { "server-1": liveSnapshot(["A", "C"]) },
      geo: [stored("A", "server-1"), stored("B", "server-1"), stored("C", "server-1", { continentCode: "NA", continent: "North America", country: "United States", countryCode: "US", latitude: 40.7, longitude: -74 })],
      serverLocations: [],
      pings: { "server-1": new Map([["a", 20], ["b", 200], ["c", 80]]) }
    });
    expect(playerRegionSummaries(entries).map((region) => [region.continentCode, region.players, Math.round(region.share * 100), region.averagePingMs])).toEqual([["EU", 2, 67, 20], ["NA", 1, 33, 80]]);
  });
});

describe("measured ping history", () => {
  it("uses the newest anonymous resource sample from each server in each bucket", () => {
    const points = playerLatencyHistory({ resourceSamples: { "server-1": [sample(1_100, 2, [20, 60]), sample(1_400, 2, [30, 70]), sample(1_900, 1)], "server-2": [sample(1_350, 1, [100])] }, from: 1_000, to: 2_000, points: 2 });
    expect(points[0]).toMatchObject({ players: 3, measuredPlayers: 3, medianPingMs: 70, p95PingMs: 100 });
    expect(points[1]).toEqual({ at: 2_000, players: 1, measuredPlayers: 0 });
  });

  it("leaves gaps when no RTT was measured", () => {
    expect(playerLatencyHistory({ resourceSamples: {}, from: 1_000, to: 2_000, points: 3 })).toEqual([
      { at: 1_000, players: 0, measuredPlayers: 0 },
      { at: 1_500, players: 0, measuredPlayers: 0 },
      { at: 2_000, players: 0, measuredPlayers: 0 }
    ]);
  });
});

describe("activity by hour", () => {
  it("counts a moment across servers as one population and leaves unseen hours unobserved", () => {
    const sampledAt = Date.UTC(2026, 7, 15, 3);
    const hours = playerActivityHours({ resourceSamples: { "server-1": [sample(sampledAt, 4)], "server-2": [sample(sampledAt, 6)] }, timeZone: "UTC", from: now - historyWindowMs });
    expect(hours[3]).toMatchObject({ averagePlayers: 10, peakPlayers: 10, samples: 1 });
    expect(hours[9]).toMatchObject({ averagePlayers: 0, samples: 0 });
    expect(quietestWindow(hours)).toBeUndefined();
  });

  it("reads the hour in the panel time zone", () => {
    const sampledAt = Date.UTC(2026, 7, 15, 3);
    const hours = playerActivityHours({ resourceSamples: { "server-1": [sample(sampledAt, 4)] }, timeZone: "Australia/Sydney", from: now - historyWindowMs });
    expect(hours.find((hour) => hour.samples > 0)?.hour).toBe(13);
  });

  it("picks the quietest run once every hour has been observed", () => {
    const busy: PlayerActivityHour[] = Array.from({ length: 24 }, (_, hour) => ({ hour, averagePlayers: hour >= 2 && hour < 6 ? 1 : 12, peakPlayers: 20, samples: 10 }));
    expect(quietestWindow(busy)).toEqual({ startHour: 2, endHour: 6, averagePlayers: 1 });
  });
});

describe("the assembled response", () => {
  it("summarizes only current measured pings and carries measurement state", () => {
    const response = buildPlayerInsights({
      servers: [servers[0]], snapshots: { "server-1": liveSnapshot(["SullyTheSnak"]) }, geo: [stored("SullyTheSnak", "server-1")], serverLocations: [{ serverId: "server-1", address: "play.example.net", location: location() }],
      pings: { "server-1": new Map([["sullythesnak", 42]]) }, pingMeasurements: [{ serverId: "server-1", status: "available", onlinePlayers: 1, measuredPlayers: 1, sampledAt: new Date(now).toISOString() }],
      resourceSamples: { "server-1": [sample(now - 1_000, 1, [42])] }, geoDatabase, timeZone: "UTC", historyWindowMs, latencyPoints: 5, now
    });
    expect(response.summary).toMatchObject({ medianPingMs: 42, p95PingMs: 42, countries: 1, onlinePlayers: 1, locatedPlayers: 1, knownPlayers: 1 });
    expect(response.pingMeasurements[0]).toMatchObject({ status: "available", measuredPlayers: 1 });
    expect(response.attribution).toContain("MaxMind");
  });

  it("does not fall back to geography or offline players", () => {
    const response = buildPlayerInsights({ servers: [servers[0]], snapshots: {}, geo: [stored("Offline", "server-1")], serverLocations: [], pings: {}, pingMeasurements: [{ serverId: "server-1", status: "idle", onlinePlayers: 0, measuredPlayers: 0 }], resourceSamples: {}, geoDatabase, timeZone: "UTC", historyWindowMs, now });
    expect(response.summary.medianPingMs).toBeUndefined();
    expect(response.players[0].pingMs).toBeUndefined();
  });
});

describe("distance", () => {
  it("still measures geography independently of ping", () => {
    const copenhagen = { latitude: 55.68, longitude: 12.57 };
    const sydney = { latitude: -33.87, longitude: 151.21 };
    expect(Math.round(greatCircleDistanceKm(copenhagen, copenhagen))).toBe(0);
    expect(Math.round(greatCircleDistanceKm(copenhagen, sydney) / 100)).toBe(160);
  });
});
