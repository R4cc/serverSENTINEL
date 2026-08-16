import { geoLite2Attribution, quietestWindow } from "@serversentinel/contracts";
import { demoFixtures } from "../../demoRuntime";
import type {
  PlayerActivityHour,
  PlayerInsightsEntry,
  PlayerInsightsResponse,
  PlayerLatencyPoint,
  PlayerLocation,
  PlayerRegionSummary
} from "../../types";
import { rangeWindowMs, type PlayerInsightsRange } from "./playerInsightsView";

/**
 * Demo fixtures for the Players workspace.
 *
 * Demo mode replaces this installation's data with a fixed fleet so the panel can be shown and
 * smoke-tested without a real server, and this is the Players half of that fixture. It is invented
 * on purpose and only ever reached on a demo path — the real workspace shows only what the panel
 * derived, and says so when it derived nothing.
 */

const demoServerLocation: PlayerLocation = {
  label: "Copenhagen",
  city: "Copenhagen",
  subdivision: "Capital Region",
  country: "Denmark",
  countryCode: "DK",
  continent: "Europe",
  continentCode: "EU",
  latitude: 55.68,
  longitude: 12.57,
  accuracyRadiusKm: 20,
  precision: "city"
};

const demoPlaces: Array<{ location: PlayerLocation; distanceKm: number; estimatedLatencyMs: number }> = [
  {
    location: { label: "Copenhagen", city: "Copenhagen", subdivision: "Capital Region", country: "Denmark", countryCode: "DK", continent: "Europe", continentCode: "EU", latitude: 55.68, longitude: 12.57, accuracyRadiusKm: 20, precision: "city" },
    distanceKm: 8,
    estimatedLatencyMs: 10
  },
  {
    location: { label: "Frankfurt", city: "Frankfurt", subdivision: "Hesse", country: "Germany", countryCode: "DE", continent: "Europe", continentCode: "EU", latitude: 50.11, longitude: 8.68, accuracyRadiusKm: 50, precision: "city" },
    distanceKm: 671,
    estimatedLatencyMs: 20
  },
  {
    location: { label: "London", city: "London", subdivision: "England", country: "United Kingdom", countryCode: "GB", continent: "Europe", continentCode: "EU", latitude: 51.51, longitude: -0.13, accuracyRadiusKm: 20, precision: "city" },
    distanceKm: 955,
    estimatedLatencyMs: 24
  },
  {
    location: { label: "New York", city: "New York", subdivision: "New York", country: "United States", countryCode: "US", continent: "North America", continentCode: "NA", latitude: 40.71, longitude: -74.01, accuracyRadiusKm: 100, precision: "city" },
    distanceKm: 6_190,
    estimatedLatencyMs: 103
  },
  {
    location: { label: "New South Wales", subdivision: "New South Wales", country: "Australia", countryCode: "AU", continent: "Oceania", continentCode: "OC", latitude: -33.87, longitude: 151.21, accuracyRadiusKm: 500, precision: "region" },
    distanceKm: 16_035,
    estimatedLatencyMs: 251
  },
  {
    location: { label: "Brazil", country: "Brazil", countryCode: "BR", continent: "South America", continentCode: "SA", latitude: -23.55, longitude: -46.63, accuracyRadiusKm: 1_000, precision: "country" },
    distanceKm: 10_326,
    estimatedLatencyMs: 165
  },
  {
    location: { label: "Tokyo", city: "Tokyo", country: "Japan", countryCode: "JP", continent: "Asia", continentCode: "AS", latitude: 35.68, longitude: 139.69, accuracyRadiusKm: 50, precision: "city" },
    distanceKm: 8_696,
    estimatedLatencyMs: 141
  }
];

function demoActivityHours(): PlayerActivityHour[] {
  // A plausible European evening curve, quietest in the small hours.
  const shape = [2, 1, 1, 0, 0, 1, 2, 3, 4, 5, 6, 7, 9, 11, 12, 14, 16, 19, 21, 20, 16, 11, 7, 4];
  return shape.map((averagePlayers, hour) => ({
    hour,
    averagePlayers,
    peakPlayers: averagePlayers + 4,
    samples: 240
  }));
}

function demoLatencySeries(range: PlayerInsightsRange, now: number, online: number): PlayerLatencyPoint[] {
  const windowMs = rangeWindowMs(range);
  const points = 96;
  return Array.from({ length: points }, (_, index) => {
    const at = now - windowMs + (windowMs / (points - 1)) * index;
    const wave = Math.sin(index / 7) * 6 + Math.sin(index / 3) * 3;
    return {
      at: Math.round(at),
      players: online,
      medianEstimatedLatencyMs: Math.max(12, Math.round(34 + wave)),
      p95EstimatedLatencyMs: Math.max(30, Math.round(98 + wave * 2))
    };
  });
}

function demoRegions(entries: readonly PlayerInsightsEntry[]): PlayerRegionSummary[] {
  const byContinent = new Map<string, PlayerInsightsEntry[]>();
  for (const entry of entries) {
    const code = entry.location?.continentCode;
    if (!code) continue;
    byContinent.set(code, [...(byContinent.get(code) ?? []), entry]);
  }
  const located = entries.filter((entry) => entry.location?.continentCode).length || 1;
  return [...byContinent.entries()]
    .map(([continentCode, members]) => ({
      continentCode: continentCode as PlayerRegionSummary["continentCode"],
      continent: members[0].location!.continent!,
      players: members.length,
      share: members.length / located,
      onlinePlayers: members.filter((member) => member.online).length,
      averageEstimatedLatencyMs: Math.round(
        members.reduce((total, member) => total + (member.estimatedLatencyMs ?? 0), 0) / members.length
      )
    }))
    .sort((left, right) => right.players - left.players);
}

export function demoPlayerInsights(serverId: string, running: boolean, range: PlayerInsightsRange): PlayerInsightsResponse {
  const now = Date.now();
  const snapshot = demoFixtures().demoPlayerSnapshot(running, serverId);
  const onlineNames = snapshot.state === "live" ? snapshot.names : [];
  // Everyone the demo fleet has ever seen: the online roster plus a few names that have played
  // before, so the history and the roster are not the same list.
  const knownNames = [...new Set([...onlineNames, "EnderBobo", "NoobMiner", "Pixel_Panda", "AlexIsHodde"])];

  const players: PlayerInsightsEntry[] = knownNames.map((player, index) => {
    const place = demoPlaces[index % demoPlaces.length];
    return {
      player,
      serverId,
      serverName: "Survival",
      online: onlineNames.includes(player),
      location: place.location,
      distanceKm: place.distanceKm,
      estimatedLatencyMs: place.estimatedLatencyMs,
      firstSeenAt: new Date(now - (index + 3) * 86_400_000).toISOString(),
      lastSeenAt: new Date(now - index * 1_800_000).toISOString(),
      observations: 12 - index
    };
  });

  const latencies = players.filter((player) => running ? player.online : true).map((player) => player.estimatedLatencyMs!);
  const sorted = [...latencies].sort((left, right) => left - right);
  const activityHours = demoActivityHours();
  const regions = demoRegions(players);

  return {
    generatedAt: new Date(now).toISOString(),
    timeZone: "UTC",
    summary: {
      medianEstimatedLatencyMs: sorted[Math.floor(sorted.length / 2)],
      p95EstimatedLatencyMs: sorted.at(-1),
      countries: new Set(players.map((player) => player.location?.countryCode)).size,
      onlinePlayers: onlineNames.length,
      locatedPlayers: players.length,
      knownPlayers: players.length,
      mostActiveRegion: regions[0],
      maintenanceWindow: quietestWindow(activityHours)
    },
    players,
    regions,
    latency: demoLatencySeries(range, now, onlineNames.length),
    activityHours,
    serverLocations: [{
      serverId,
      address: "play.demo.example",
      location: demoServerLocation,
      resolvedAt: new Date(now - 3_600_000).toISOString()
    }],
    geoDatabase: {
      available: true,
      configured: true,
      buildDate: new Date(now - 3 * 86_400_000).toISOString(),
      databaseType: "GeoLite2-City",
      downloadedAt: new Date(now - 86_400_000).toISOString(),
      updating: false
    },
    attribution: geoLite2Attribution
  };
}
