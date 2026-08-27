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
import { buildPlayerInsights, playerActivityHours, playerInsightsEntries, playerRegionSummaries, stintAt } from "./playerInsights.js";

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
  const firstSeenAt = now - 86_400_000;
  return {
    serverId,
    player,
    playerKey: player.toLowerCase(),
    stints: [{ location: location(overrides), firstSeenAt, lastSeenAt, observations: 3 }],
    location: location(overrides),
    firstSeenAt,
    lastSeenAt,
    observations: 3
  };
}

/** A player the panel placed in two different countries, oldest run first. */
function moved(player: string, serverId: string, runs: Array<{ location: Partial<PlayerLocation>; from: number; to: number }>): StoredPlayerGeo {
  const stints = runs.map((run) => ({
    location: location(run.location),
    firstSeenAt: run.from,
    lastSeenAt: run.to,
    observations: 1
  }));
  return {
    serverId,
    player,
    playerKey: player.toLowerCase(),
    stints,
    location: stints.at(-1)!.location,
    firstSeenAt: stints[0].firstSeenAt,
    lastSeenAt: stints.at(-1)!.lastSeenAt,
    observations: stints.length
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

  it("uses one observation per server when five-second samples share a ten-second slot", () => {
    const baseline = samples([3], 3)[0];
    const first = { ...baseline, sampledAt: baseline.sampledAt + 5_000 };
    const second = { ...baseline, sampledAt: baseline.sampledAt + 10_000, playersOnline: 4 };
    const hours = playerActivityHours({
      resourceSamples: {
        "server-1": [first, second],
        "server-2": [{ ...second, playersOnline: 6 }]
      },
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

  it("keeps a session that began before a shorter chart range when the snapshot is unavailable", () => {
    const oneHour = 60 * 60 * 1000;
    const response = insights({
      historyWindowMs: oneHour,
      activityWindowMs: historyWindowMs,
      snapshots: {},
      timelineEvents: {
        "server-1": [{ ...timelineEvents["server-1"][0], occurredAt: now - 2 * oneHour }]
      }
    });

    expect(response.latency.every((point) => point.players === 1)).toBe(true);
    expect(response.latency.at(-1)?.medianEstimatedLatencyMs).toBeGreaterThan(10);
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

/**
 * The property that made a geography history necessary. With one location per player, a player
 * moving rewrote every hour of the chart that had already been drawn.
 */
describe("history that stays put when a player moves", () => {
  const movedAt = now - 2 * 60 * 60 * 1000;
  const sydney = { label: "Sydney", city: "Sydney", country: "Australia", countryCode: "AU", continent: "Oceania", continentCode: "OC" as const, latitude: -33.87, longitude: 151.21 };

  function joinEvent(id: string, player: string, occurredAt: number): ServerTimelineEvent {
    return {
      id,
      eventType: "player_joined",
      type: "success",
      severity: "success",
      text: `${player} joined`,
      message: `${player} joined`,
      signature: `player_joined:${player.toLowerCase()}`,
      source: "docker",
      subject: player,
      occurredAt
    };
  }

  function leaveEvent(id: string, player: string, occurredAt: number): ServerTimelineEvent {
    return { ...joinEvent(id, player, occurredAt), eventType: "player_left", type: "info", severity: "info", signature: `player_left:${player.toLowerCase()}` };
  }

  const wanderer = moved("Wanderer", "server-1", [
    { location: {}, from: now - 6 * 60 * 60 * 1000, to: now - 5 * 60 * 60 * 1000 },
    { location: sydney, from: movedAt, to: now - 60_000 }
  ]);

  function series(geo = [wanderer]) {
    return buildPlayerInsights({
      servers: [servers[0]],
      snapshots: {},
      geo,
      serverLocations: [{ serverId: "server-1", address: "play.example.net", location: location({ label: "Frankfurt", city: "Frankfurt", latitude: 50.11, longitude: 8.68 }) }],
      timelineEvents: {
        "server-1": [
          joinEvent("join-old", "Wanderer", now - 6 * 60 * 60 * 1000),
          leaveEvent("leave-old", "Wanderer", now - 5 * 60 * 60 * 1000),
          joinEvent("join-new", "Wanderer", movedAt),
          leaveEvent("leave-new", "Wanderer", now - 60_000)
        ]
      },
      resourceSamples: {},
      geoDatabase,
      timeZone: "UTC",
      historyWindowMs: 8 * 60 * 60 * 1000,
      latencyPoints: 97,
      now
    }).latency;
  }

  it("estimates each session from where the player was then, not where they are now", () => {
    const latency = series();
    const older = latency.filter((point) => point.at < movedAt && point.medianEstimatedLatencyMs !== undefined);
    const newer = latency.filter((point) => point.at > movedAt && point.medianEstimatedLatencyMs !== undefined);

    expect(older.length).toBeGreaterThan(0);
    expect(newer.length).toBeGreaterThan(0);
    // Copenhagen to Frankfurt is a few hundred kilometres; Sydney is most of a planet away.
    expect(older.every((point) => point.medianEstimatedLatencyMs! < 60)).toBe(true);
    expect(newer.every((point) => point.medianEstimatedLatencyMs! > 200)).toBe(true);
  });

  it("counts a session it cannot place, and estimates nothing for it", () => {
    // The player's earliest recorded location starts after their first session, which is what an
    // upgraded installation looks like: the sessions before it have no location to be measured from.
    const latePlacement = moved("Wanderer", "server-1", [{ location: sydney, from: movedAt, to: now - 60_000 }]);
    const latency = series([latePlacement]);
    const early = latency.find((point) => point.at > now - 6 * 60 * 60 * 1000 && point.at < now - 5 * 60 * 60 * 1000);

    expect(early?.players).toBe(1);
    expect(early?.medianEstimatedLatencyMs).toBeUndefined();
  });
});

describe("where a player was at a given moment", () => {
  const stints = [
    { location: location(), firstSeenAt: 1_000, lastSeenAt: 2_000, observations: 1 },
    { location: location({ label: "Sydney", city: "Sydney" }), firstSeenAt: 5_000, lastSeenAt: 6_000, observations: 1 }
  ];

  it("uses the run that had already begun, including in the gap between two runs", () => {
    expect(stintAt(stints, 1_500)?.location.city).toBe("Copenhagen");
    expect(stintAt(stints, 3_000)?.location.city).toBe("Copenhagen");
    expect(stintAt(stints, 5_500)?.location.city).toBe("Sydney");
    expect(stintAt(stints, 9_000)?.location.city).toBe("Sydney");
  });

  it("has no answer before the first observation, rather than guessing forward", () => {
    expect(stintAt(stints, 500)).toBeUndefined();
    expect(stintAt([], 1_000)).toBeUndefined();
  });
});
