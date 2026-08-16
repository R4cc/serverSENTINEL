import { describe, expect, it } from "vitest";
import {
  estimatedLatencyMsForDistanceKm,
  greatCircleDistanceKm,
  quietestWindow,
  type PlayerActivityHour,
  type PlayerGeoDatabaseState,
  type PlayerLocation
} from "@serversentinel/contracts";
import type { ResourceStatsSample } from "../resourceStatsCollector.js";
import type { StoredPlayerGeo } from "../storage/playerGeoRepository.js";
import type { ManagedServer, PlayerSnapshot, ServerTimelineEvent } from "../types.js";
import { buildPlayerInsights, playerActivityHours, playerInsightsEntries, playerRegionSummaries } from "./playerInsights.js";

const now = Date.parse("2026-08-16T12:00:00.000Z");
const historyWindowMs = 7 * 24 * 60 * 60 * 1000;

const servers = [
  { id: "server-1", displayName: "Survival" },
  { id: "server-2", displayName: "Creative" }
] as ManagedServer[];

const geoDatabase: PlayerGeoDatabaseState = { available: true, configured: true, updating: false };

function location(overrides: Partial<PlayerLocation> = {}): PlayerLocation {
  return { label: "Copenhagen", city: "Copenhagen", country: "Denmark", countryCode: "DK", continent: "Europe", continentCode: "EU", latitude: 55.68, longitude: 12.57, accuracyRadiusKm: 20, precision: "city", ...overrides };
}

function stored(player: string, serverId: string, overrides: Partial<PlayerLocation> = {}, lastSeenAt = now - 60_000): StoredPlayerGeo {
  return {
    serverId,
    player,
    playerKey: player.toLowerCase(),
    location: location(overrides),
    firstSeenAt: now - 86_400_000,
    lastSeenAt,
    observations: 3
  };
}

function liveSnapshot(names: string[]): PlayerSnapshot {
  return { state: "live", online: names.length, maxPlayers: 20, names, sampledAt: new Date(now).toISOString() };
}

describe("the latency model", () => {
  it("scales with distance and never claims zero", () => {
    expect(estimatedLatencyMsForDistanceKm(0)).toBe(10);
    // Copenhagen to Frankfurt is about 670 km.
    expect(estimatedLatencyMsForDistanceKm(670)).toBe(20);
    expect(estimatedLatencyMsForDistanceKm(8_000)).toBeGreaterThan(estimatedLatencyMsForDistanceKm(2_000)!);
    expect(estimatedLatencyMsForDistanceKm(-1)).toBeUndefined();
    expect(estimatedLatencyMsForDistanceKm(Number.NaN)).toBeUndefined();
  });

  it("measures distance the way a globe does", () => {
    const copenhagen = { latitude: 55.68, longitude: 12.57 };
    const sydney = { latitude: -33.87, longitude: 151.21 };
    expect(Math.round(greatCircleDistanceKm(copenhagen, copenhagen))).toBe(0);
    expect(Math.round(greatCircleDistanceKm(copenhagen, sydney) / 100)).toBe(160);
  });
});

describe("player entries", () => {
  const serverLocations = [
    { serverId: "server-1", address: "play.example.net", location: location({ label: "Frankfurt", city: "Frankfurt", country: "Germany", countryCode: "DE", latitude: 50.11, longitude: 8.68 }) },
    { serverId: "server-2" }
  ];

  it("estimates latency only where both ends are known", () => {
    const entries = playerInsightsEntries({
      servers,
      snapshots: {},
      geo: [stored("SullyTheSnak", "server-1"), stored("EnderBobo", "server-2")],
      serverLocations
    });
    const withReference = entries.find((entry) => entry.player === "SullyTheSnak");
    const withoutReference = entries.find((entry) => entry.player === "EnderBobo");

    expect(withReference?.distanceKm).toBeGreaterThan(500);
    expect(withReference?.estimatedLatencyMs).toBeGreaterThan(10);
    // The second server has no configured address, so nothing about it can be estimated.
    expect(withoutReference?.distanceKm).toBeUndefined();
    expect(withoutReference?.estimatedLatencyMs).toBeUndefined();
    expect(withoutReference?.location?.city).toBe("Copenhagen");
  });

  it("withholds latency for a player whose own location is unknown", () => {
    const entries = playerInsightsEntries({
      servers,
      snapshots: { "server-1": liveSnapshot(["Newcomer"]) },
      geo: [],
      serverLocations
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ player: "Newcomer", online: true, observations: 0 });
    expect(entries[0].location).toBeUndefined();
    expect(entries[0].estimatedLatencyMs).toBeUndefined();
  });

  it("marks the players the current observation names as online, matching regardless of case", () => {
    const entries = playerInsightsEntries({
      servers,
      snapshots: { "server-1": liveSnapshot(["sullythesnak"]) },
      geo: [stored("SullyTheSnak", "server-1"), stored("EnderBobo", "server-1")],
      serverLocations
    });
    expect(entries.find((entry) => entry.player === "SullyTheSnak")?.online).toBe(true);
    expect(entries.find((entry) => entry.player === "EnderBobo")?.online).toBe(false);
    // An online player is never listed twice because the snapshot also names them.
    expect(entries.filter((entry) => entry.player.toLowerCase() === "sullythesnak")).toHaveLength(1);
  });

  it("drops geography for a server this installation no longer has", () => {
    const entries = playerInsightsEntries({ servers, snapshots: {}, geo: [stored("Ghost", "deleted-server")], serverLocations });
    expect(entries).toEqual([]);
  });
});

describe("regional spread", () => {
  it("shares are of the located players, not of everyone", () => {
    const entries = playerInsightsEntries({
      servers,
      snapshots: { "server-1": liveSnapshot(["Unlocatable"]) },
      geo: [
        stored("A", "server-1"),
        stored("B", "server-1"),
        stored("C", "server-1", { continentCode: "NA", continent: "North America", country: "United States", countryCode: "US", latitude: 40.7, longitude: -74 })
      ],
      serverLocations: []
    });
    const regions = playerRegionSummaries(entries);
    expect(regions.map((region) => [region.continentCode, region.players, Math.round(region.share * 100)])).toEqual([
      ["EU", 2, 67],
      ["NA", 1, 33]
    ]);
  });

  it("has nothing to report when nobody has been located", () => {
    expect(playerRegionSummaries([])).toEqual([]);
  });
});

describe("activity by hour", () => {
  function samples(hours: number[], playersPerHour: number): ResourceStatsSample[] {
    return hours.map((hour) => ({
      available: true,
      running: true,
      cpuPercent: 1,
      memoryUsageBytes: 1,
      memoryLimitBytes: 2,
      readAt: new Date(Date.UTC(2026, 7, 15, hour)).toISOString(),
      sampledAt: Date.UTC(2026, 7, 15, hour),
      playersOnline: playersPerHour
    }));
  }

  it("reports hours it has no samples for as unobserved rather than empty", () => {
    const hours = playerActivityHours({
      resourceSamples: { "server-1": samples([3, 4], 5) },
      timeZone: "UTC",
      from: now - historyWindowMs
    });
    expect(hours).toHaveLength(24);
    expect(hours[3]).toMatchObject({ hour: 3, averagePlayers: 5, peakPlayers: 5, samples: 1 });
    expect(hours[9]).toMatchObject({ hour: 9, averagePlayers: 0, samples: 0 });
    // Not every hour has been seen, so no maintenance window may be recommended yet.
    expect(quietestWindow(hours)).toBeUndefined();
  });

  it("counts a moment across servers as one population", () => {
    const hours = playerActivityHours({
      resourceSamples: { "server-1": samples([3], 4), "server-2": samples([3], 6) },
      timeZone: "UTC",
      from: now - historyWindowMs
    });
    expect(hours[3]).toMatchObject({ averagePlayers: 10, peakPlayers: 10, samples: 1 });
  });

  it("reads the hour in the panel's own time zone", () => {
    const hours = playerActivityHours({
      resourceSamples: { "server-1": samples([3], 4) },
      timeZone: "Australia/Sydney",
      from: now - historyWindowMs
    });
    expect(hours.find((hour) => hour.samples > 0)?.hour).toBe(13);
  });

  it("picks the quietest run of hours once every hour has been observed", () => {
    const busy: PlayerActivityHour[] = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      averagePlayers: hour >= 2 && hour < 6 ? 1 : 12,
      peakPlayers: 20,
      samples: 10
    }));
    expect(quietestWindow(busy)).toEqual({ startHour: 2, endHour: 6, averagePlayers: 1 });
  });
});

describe("the assembled response", () => {
  const timelineEvents: Record<string, ServerTimelineEvent[]> = {
    "server-1": [
      {
        id: "join-1",
        eventType: "player_joined",
        type: "success",
        severity: "success",
        text: "SullyTheSnak joined",
        message: "SullyTheSnak joined",
        signature: "player_joined:sullythesnak",
        source: "docker",
        subject: "SullyTheSnak",
        occurredAt: now - 3 * 60 * 60 * 1000
      }
    ]
  };

  function insights(overrides: Partial<Parameters<typeof buildPlayerInsights>[0]> = {}) {
    return buildPlayerInsights({
      servers,
      snapshots: { "server-1": liveSnapshot(["SullyTheSnak"]) },
      geo: [stored("SullyTheSnak", "server-1")],
      serverLocations: [{ serverId: "server-1", address: "play.example.net", location: location({ label: "Frankfurt", city: "Frankfurt", latitude: 50.11, longitude: 8.68 }) }],
      timelineEvents,
      resourceSamples: {},
      geoDatabase,
      timeZone: "UTC",
      historyWindowMs,
      latencyPoints: 5,
      now,
      ...overrides
    });
  }

  it("summarises what it actually knows", () => {
    const response = insights();
    expect(response.summary).toMatchObject({ countries: 1, onlinePlayers: 1, locatedPlayers: 1, knownPlayers: 1 });
    expect(response.summary.medianEstimatedLatencyMs).toBeGreaterThan(10);
    expect(response.summary.mostActiveRegion?.continentCode).toBe("EU");
    // No resource samples means no evidence about quiet hours, so none is offered.
    expect(response.summary.maintenanceWindow).toBeUndefined();
    expect(response.attribution).toContain("MaxMind");
  });

  it("reconstructs a latency series from the join history it already had", () => {
    const response = insights();
    expect(response.latency).toHaveLength(5);
    expect(response.latency.at(-1)?.players).toBe(1);
    expect(response.latency.at(-1)?.medianEstimatedLatencyMs).toBe(response.summary.medianEstimatedLatencyMs);
    // Before the join there was nobody online, so there is nothing to estimate.
    expect(response.latency[0]).toMatchObject({ players: 0 });
    expect(response.latency[0].medianEstimatedLatencyMs).toBeUndefined();
  });

  it("says nothing rather than something invented when there is no geography at all", () => {
    const response = insights({
      geo: [],
      snapshots: {},
      serverLocations: [],
      geoDatabase: { available: false, configured: false, updating: false }
    });
    expect(response.summary).toMatchObject({ countries: 0, onlinePlayers: 0, locatedPlayers: 0, knownPlayers: 0 });
    expect(response.summary.medianEstimatedLatencyMs).toBeUndefined();
    expect(response.summary.mostActiveRegion).toBeUndefined();
    expect(response.regions).toEqual([]);
    expect(response.players).toEqual([]);
    expect(response.geoDatabase.available).toBe(false);
  });

  it("falls back to everyone it has seen when nobody is online", () => {
    const response = insights({ snapshots: {} });
    expect(response.summary.onlinePlayers).toBe(0);
    expect(response.summary.medianEstimatedLatencyMs).toBeGreaterThan(10);
  });
});
