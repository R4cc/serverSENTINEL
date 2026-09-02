/**
 * The Player Insights contract.
 *
 * Everything here describes information the panel can actually obtain: player names come from the
 * Minecraft Query observation the panel already collects, and their geography is resolved from a
 * MaxMind GeoLite2 City database the panel holds itself, against the address the Minecraft server
 * logged when the player joined.
 *
 * The guarantee this module makes about that address is precise, and worth stating precisely.
 * Player Insights does not persist it: geography lookup and live TCP matching happen in memory,
 * and the endpoint is discarded when the player disconnects. Only the derived location and
 * anonymous RTT samples survive. The lookup itself is a local database read, so no address is sent
 * to MaxMind or to any other geolocation service. What this is *not* is a claim that the address
 * never leaves the machine the Minecraft server runs on — a server on a remote node reaches the
 * panel over the node protocol, and its console output travels with it, addresses and all, exactly
 * as it did before this module existed.
 *
 * Player latency is measured from the Linux TCP connection owned by the Minecraft server
 * container. The connection endpoint used to associate that measurement with a player remains
 * private to the collector and is never part of this public contract.
 */

/** GeoLite2's own continent codes, kept verbatim so a lookup result maps straight onto the UI. */
export type PlayerContinentCode = "AF" | "AN" | "AS" | "EU" | "NA" | "OC" | "SA";

export const playerContinentNames: Readonly<Record<PlayerContinentCode, string>> = {
  AF: "Africa",
  AN: "Antarctica",
  AS: "Asia",
  EU: "Europe",
  NA: "North America",
  OC: "Oceania",
  SA: "South America"
};

export function isPlayerContinentCode(value: unknown): value is PlayerContinentCode {
  return typeof value === "string" && value in playerContinentNames;
}

/**
 * How precise a resolved location is, which decides how it may be described and drawn.
 *
 * GeoLite2 reports an accuracy radius with every city, and a city whose radius covers half a
 * country is a country-level answer wearing a city's name. `precision` is what the rest of the
 * feature reads, so nothing has to re-derive that judgement from the radius.
 */
export type PlayerLocationPrecision = "city" | "region" | "country";

/**
 * A city answer is only presented as a city while its accuracy radius stays inside this many
 * kilometres. Beyond it the same record is described by its subdivision or country instead: the
 * coordinates are still the best estimate available, but the city name would overstate them.
 *
 * Fifty kilometres is roughly the scale at which a city name still means the city. GeoLite2 reports
 * radii of several hundred kilometres for a great many allocations — mobile carriers and small
 * countries especially — and naming a city for those said something the data does not support.
 */
export const playerCityAccuracyRadiusLimitKm = 50;

/**
 * The derived geography of one player, as stored and as served. There is deliberately no address
 * field, hashed or otherwise: the lookup happens once, in memory, and only this survives it.
 */
export type PlayerLocation = {
  /** Best available place name at `precision` — a city, a subdivision, or a country. */
  label: string;
  city?: string;
  subdivision?: string;
  country?: string;
  countryCode?: string;
  continent?: string;
  continentCode?: PlayerContinentCode;
  /** Approximate, and never the player's address: GeoLite2 city coordinates are area centroids. */
  latitude?: number;
  longitude?: number;
  /** GeoLite2's own confidence radius around those coordinates, in kilometres. */
  accuracyRadiusKm?: number;
  precision: PlayerLocationPrecision;
};

export type PlayerInsightsEntry = {
  player: string;
  serverId: string;
  serverName: string;
  /** True while the player appears in the server's current Minecraft Query observation. */
  online: boolean;
  location?: PlayerLocation;
  /** Great-circle distance to the server's own location, when both are known. */
  distanceKm?: number;
  /** Linux TCP round-trip time while this player is directly matched and currently connected. */
  pingMs?: number;
  firstSeenAt?: string;
  lastSeenAt?: string;
  /** How many distinct joins this player's stored location was derived from. */
  observations: number;
};

export type PlayerRegionSummary = {
  continentCode: PlayerContinentCode;
  continent: string;
  players: number;
  /** Share of all players whose continent is known, 0-1. */
  share: number;
  onlinePlayers: number;
  /** Average measured ping of currently connected, matched players in this region. */
  averagePingMs?: number;
};

export type PlayerLatencyPoint = {
  at: number;
  /** Players online in the resource sample represented by this point. */
  players: number;
  /** Number of player TCP connections contributing measured RTT values. */
  measuredPlayers: number;
  medianPingMs?: number;
  p95PingMs?: number;
};

export type PlayerPingMeasurementStatus = "idle" | "available" | "unsupported" | "unavailable";

export type PlayerPingMeasurement = {
  serverId: string;
  status: PlayerPingMeasurementStatus;
  onlinePlayers: number;
  measuredPlayers: number;
  sampledAt?: string;
  /** Sanitized operational guidance; never contains a player address or connection endpoint. */
  message?: string;
};

/** One hour of the day, averaged over the retained activity history, in the panel's time zone. */
export type PlayerActivityHour = {
  hour: number;
  averagePlayers: number;
  peakPlayers: number;
  /** Hours with no retained samples are reported rather than silently averaged as empty. */
  samples: number;
};

export type PlayerMaintenanceWindow = {
  startHour: number;
  endHour: number;
  averagePlayers: number;
};

/** Where the panel measures distance from, and how it learned that. */
export type PlayerInsightsServerLocation = {
  serverId: string;
  /** The public address an operator entered for this server; never a player's address. */
  address?: string;
  location?: PlayerLocation;
  resolvedAt?: string;
  /** Why the address could not be resolved, when it could not. */
  error?: string;
};

export type PlayerGeoDatabaseState = {
  /** Whether a GeoLite2 City database is loaded and answering lookups. */
  available: boolean;
  /** Whether MaxMind credentials are configured, so the panel may download and refresh it. */
  configured: boolean;
  buildDate?: string;
  databaseType?: string;
  nodeCount?: number;
  downloadedAt?: string;
  lastCheckedAt?: string;
  updating: boolean;
  error?: string;
};

export type PlayerInsightsSummary = {
  /** Median measured TCP RTT of the players currently online and matched. */
  medianPingMs?: number;
  p95PingMs?: number;
  /** Distinct countries seen across the retained history. */
  countries: number;
  onlinePlayers: number;
  locatedPlayers: number;
  knownPlayers: number;
  mostActiveRegion?: PlayerRegionSummary;
  maintenanceWindow?: PlayerMaintenanceWindow;
};

export type PlayerInsightsResponse = {
  generatedAt: string;
  timeZone: string;
  summary: PlayerInsightsSummary;
  players: PlayerInsightsEntry[];
  regions: PlayerRegionSummary[];
  latency: PlayerLatencyPoint[];
  pingMeasurements: PlayerPingMeasurement[];
  activityHours: PlayerActivityHour[];
  serverLocations: PlayerInsightsServerLocation[];
  geoDatabase: PlayerGeoDatabaseState;
  /** GeoLite2's licence requires this to be shown wherever its data is. */
  attribution: string;
};

export const geoLite2Attribution = "This product includes GeoLite2 data created by MaxMind, available from https://www.maxmind.com";

export const earthRadiusKm = 6_371;

/** Great-circle distance in kilometres between two approximate positions. */
export function greatCircleDistanceKm(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number }
) {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLatitude = toRadians(to.latitude - from.latitude);
  const deltaLongitude = toRadians(to.longitude - from.longitude);
  const fromLatitude = toRadians(from.latitude);
  const toLatitude = toRadians(to.latitude);
  const haversine = Math.sin(deltaLatitude / 2) ** 2
    + Math.cos(fromLatitude) * Math.cos(toLatitude) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.min(1, Math.sqrt(haversine)));
}

export function medianOf(values: readonly number[]) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

/** The value at or below which `percentile` of the samples fall, by nearest rank. */
export function percentileOf(values: readonly number[], percentile: number) {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.ceil((percentile / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * The quietest run of `windowHours` consecutive hours, wrapping around midnight.
 *
 * Hours with no retained samples are not evidence of quiet, so a window is only offered once every
 * hour it covers has been observed. That is what keeps a fresh installation from recommending the
 * hours it simply has not seen yet.
 */
export function quietestWindow(hours: readonly PlayerActivityHour[], windowHours = 4): PlayerMaintenanceWindow | undefined {
  if (hours.length !== 24 || windowHours < 1 || windowHours > 24) return undefined;
  if (hours.some((hour) => hour.samples === 0)) return undefined;
  let best: PlayerMaintenanceWindow | undefined;
  for (let start = 0; start < 24; start += 1) {
    let total = 0;
    for (let offset = 0; offset < windowHours; offset += 1) total += hours[(start + offset) % 24].averagePlayers;
    const averagePlayers = total / windowHours;
    if (!best || averagePlayers < best.averagePlayers - 1e-9) {
      best = { startHour: start, endHour: (start + windowHours) % 24, averagePlayers };
    }
  }
  return best;
}
