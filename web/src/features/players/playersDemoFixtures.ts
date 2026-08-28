import {
  estimatedLatencyMsForDistanceKm,
  geoLite2Attribution,
  greatCircleDistanceKm,
  quietestWindow
} from "@serversentinel/contracts";
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

const demoServerCoordinates = { latitude: 55.68, longitude: 12.57 } as const;

const demoServerLocation: PlayerLocation = {
  label: "Copenhagen",
  city: "Copenhagen",
  subdivision: "Capital Region",
  country: "Denmark",
  countryCode: "DK",
  continent: "Europe",
  continentCode: "EU",
  ...demoServerCoordinates,
  accuracyRadiusKm: 20,
  precision: "city"
};

type DemoLocation = PlayerLocation & Required<Pick<PlayerLocation, "latitude" | "longitude">>;

function demoPlace(location: DemoLocation) {
  const distanceKm = greatCircleDistanceKm(demoServerCoordinates, location);
  return {
    location,
    distanceKm,
    estimatedLatencyMs: estimatedLatencyMsForDistanceKm(distanceKm)!
  };
}

// Interleave continents so even the smallest randomized demo roster looks geographically varied.
// The full roster covers 36 cities and 33 countries, while nearby cities still exercise clustering.
const demoPlaces = [
  demoPlace({ label: "Copenhagen", city: "Copenhagen", subdivision: "Capital Region", country: "Denmark", countryCode: "DK", continent: "Europe", continentCode: "EU", latitude: 55.68, longitude: 12.57, accuracyRadiusKm: 20, precision: "city" }),
  demoPlace({ label: "New York", city: "New York", subdivision: "New York", country: "United States", countryCode: "US", continent: "North America", continentCode: "NA", latitude: 40.71, longitude: -74.01, accuracyRadiusKm: 20, precision: "city" }),
  demoPlace({ label: "Tokyo", city: "Tokyo", country: "Japan", countryCode: "JP", continent: "Asia", continentCode: "AS", latitude: 35.68, longitude: 139.69, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "São Paulo", city: "São Paulo", subdivision: "São Paulo", country: "Brazil", countryCode: "BR", continent: "South America", continentCode: "SA", latitude: -23.55, longitude: -46.63, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Sydney", city: "Sydney", subdivision: "New South Wales", country: "Australia", countryCode: "AU", continent: "Oceania", continentCode: "OC", latitude: -33.87, longitude: 151.21, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Cape Town", city: "Cape Town", subdivision: "Western Cape", country: "South Africa", countryCode: "ZA", continent: "Africa", continentCode: "AF", latitude: -33.92, longitude: 18.42, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "London", city: "London", subdivision: "England", country: "United Kingdom", countryCode: "GB", continent: "Europe", continentCode: "EU", latitude: 51.51, longitude: -0.13, accuracyRadiusKm: 20, precision: "city" }),
  demoPlace({ label: "Toronto", city: "Toronto", subdivision: "Ontario", country: "Canada", countryCode: "CA", continent: "North America", continentCode: "NA", latitude: 43.65, longitude: -79.38, accuracyRadiusKm: 20, precision: "city" }),
  demoPlace({ label: "Singapore", city: "Singapore", country: "Singapore", countryCode: "SG", continent: "Asia", continentCode: "AS", latitude: 1.35, longitude: 103.82, accuracyRadiusKm: 20, precision: "city" }),
  demoPlace({ label: "Buenos Aires", city: "Buenos Aires", country: "Argentina", countryCode: "AR", continent: "South America", continentCode: "SA", latitude: -34.60, longitude: -58.38, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Auckland", city: "Auckland", country: "New Zealand", countryCode: "NZ", continent: "Oceania", continentCode: "OC", latitude: -36.85, longitude: 174.76, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Nairobi", city: "Nairobi", country: "Kenya", countryCode: "KE", continent: "Africa", continentCode: "AF", latitude: -1.29, longitude: 36.82, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Frankfurt", city: "Frankfurt", subdivision: "Hesse", country: "Germany", countryCode: "DE", continent: "Europe", continentCode: "EU", latitude: 50.11, longitude: 8.68, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Mexico City", city: "Mexico City", country: "Mexico", countryCode: "MX", continent: "North America", continentCode: "NA", latitude: 19.43, longitude: -99.13, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Seoul", city: "Seoul", country: "South Korea", countryCode: "KR", continent: "Asia", continentCode: "AS", latitude: 37.57, longitude: 126.98, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Santiago", city: "Santiago", country: "Chile", countryCode: "CL", continent: "South America", continentCode: "SA", latitude: -33.45, longitude: -70.67, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Suva", city: "Suva", country: "Fiji", countryCode: "FJ", continent: "Oceania", continentCode: "OC", latitude: -18.14, longitude: 178.44, accuracyRadiusKm: 100, precision: "city" }),
  demoPlace({ label: "Cairo", city: "Cairo", country: "Egypt", countryCode: "EG", continent: "Africa", continentCode: "AF", latitude: 30.04, longitude: 31.24, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Paris", city: "Paris", country: "France", countryCode: "FR", continent: "Europe", continentCode: "EU", latitude: 48.86, longitude: 2.35, accuracyRadiusKm: 20, precision: "city" }),
  demoPlace({ label: "San José", city: "San José", country: "Costa Rica", countryCode: "CR", continent: "North America", continentCode: "NA", latitude: 9.93, longitude: -84.08, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Mumbai", city: "Mumbai", subdivision: "Maharashtra", country: "India", countryCode: "IN", continent: "Asia", continentCode: "AS", latitude: 19.08, longitude: 72.88, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Lima", city: "Lima", country: "Peru", countryCode: "PE", continent: "South America", continentCode: "SA", latitude: -12.05, longitude: -77.04, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Melbourne", city: "Melbourne", subdivision: "Victoria", country: "Australia", countryCode: "AU", continent: "Oceania", continentCode: "OC", latitude: -37.81, longitude: 144.96, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Lagos", city: "Lagos", country: "Nigeria", countryCode: "NG", continent: "Africa", continentCode: "AF", latitude: 6.52, longitude: 3.38, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Vienna", city: "Vienna", country: "Austria", countryCode: "AT", continent: "Europe", continentCode: "EU", latitude: 48.21, longitude: 16.37, accuracyRadiusKm: 20, precision: "city" }),
  demoPlace({ label: "Havana", city: "Havana", country: "Cuba", countryCode: "CU", continent: "North America", continentCode: "NA", latitude: 23.11, longitude: -82.37, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Dubai", city: "Dubai", country: "United Arab Emirates", countryCode: "AE", continent: "Asia", continentCode: "AS", latitude: 25.20, longitude: 55.27, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Bogotá", city: "Bogotá", country: "Colombia", countryCode: "CO", continent: "South America", continentCode: "SA", latitude: 4.71, longitude: -74.07, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Wellington", city: "Wellington", country: "New Zealand", countryCode: "NZ", continent: "Oceania", continentCode: "OC", latitude: -41.29, longitude: 174.78, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Casablanca", city: "Casablanca", country: "Morocco", countryCode: "MA", continent: "Africa", continentCode: "AF", latitude: 33.57, longitude: -7.59, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Stockholm", city: "Stockholm", country: "Sweden", countryCode: "SE", continent: "Europe", continentCode: "EU", latitude: 59.33, longitude: 18.07, accuracyRadiusKm: 20, precision: "city" }),
  demoPlace({ label: "Vancouver", city: "Vancouver", subdivision: "British Columbia", country: "Canada", countryCode: "CA", continent: "North America", continentCode: "NA", latitude: 49.28, longitude: -123.12, accuracyRadiusKm: 20, precision: "city" }),
  demoPlace({ label: "Bangkok", city: "Bangkok", country: "Thailand", countryCode: "TH", continent: "Asia", continentCode: "AS", latitude: 13.76, longitude: 100.50, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Montevideo", city: "Montevideo", country: "Uruguay", countryCode: "UY", continent: "South America", continentCode: "SA", latitude: -34.90, longitude: -56.16, accuracyRadiusKm: 50, precision: "city" }),
  demoPlace({ label: "Port Moresby", city: "Port Moresby", country: "Papua New Guinea", countryCode: "PG", continent: "Oceania", continentCode: "OC", latitude: -9.44, longitude: 147.18, accuracyRadiusKm: 100, precision: "city" }),
  demoPlace({ label: "Accra", city: "Accra", country: "Ghana", countryCode: "GH", continent: "Africa", continentCode: "AF", latitude: 5.60, longitude: -0.19, accuracyRadiusKm: 50, precision: "city" })
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
    const members = byContinent.get(code);
    if (members) members.push(entry);
    else byContinent.set(code, [entry]);
  }
  const located = [...byContinent.values()].reduce((total, members) => total + members.length, 0) || 1;
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
  const onlineNow = new Set(onlineNames);

  const players: PlayerInsightsEntry[] = knownNames.map((player, index) => {
    const place = demoPlaces[index % demoPlaces.length];
    return {
      player,
      serverId,
      serverName: "Survival",
      online: onlineNow.has(player),
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
