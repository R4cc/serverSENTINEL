/**
 * The Player Insights contract.
 *
 * Everything here describes information the panel can actually obtain: player names come from the
 * Minecraft Query observation the panel already collects, and their geography is resolved locally
 * from a MaxMind GeoLite2 City database against the address the Minecraft server logged when the
 * player joined. That address is never stored — only the derived location below survives the
 * lookup — so the history this module keeps cannot be turned back into who connected from where.
 *
 * No Minecraft protocol the panel can speak reports a player's own round-trip time, so latency is
 * never claimed as measured. It is estimated from the distance between the player's approximate
 * location and the server's, and every latency field in this file is named accordingly.
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
 */
export const playerCityAccuracyRadiusLimitKm = 200;

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
  /** Estimated, never measured. Absent whenever the server or the player location is unknown. */
  estimatedLatencyMs?: number;
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
  averageEstimatedLatencyMs?: number;
};

export type PlayerLatencyPoint = {
  at: number;
  /** Players online at this instant, reconstructed from the panel's own join and leave history. */
  players: number;
  /** Median estimated latency of the players online then; absent when none of them are located. */
  medianEstimatedLatencyMs?: number;
  p95EstimatedLatencyMs?: number;
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
  /** Median estimated latency of the players currently online, across every managed server. */
  medianEstimatedLatencyMs?: number;
  p95EstimatedLatencyMs?: number;
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

/**
 * The latency model, written down once so the UI can explain it in the same terms the panel used.
 *
 * Light travels through fibre at roughly two thirds of its vacuum speed, a real route is longer
 * than the great-circle path between its ends, and every hop adds a little switching and queuing
 * delay. None of that makes the result a measurement, which is why every field it feeds is named
 * "estimated" — but it is derived from the two positions rather than invented, and it ranks and
 * groups players the way their real latency does.
 */
export const latencyModel = {
  /** Kilometres per millisecond through fibre: about 0.66c. */
  fibrePropagationKmPerMs: 199.9,
  /** How much longer a routed path is than the straight line between its ends. */
  routePathFactor: 1.5,
  /** Switching, queuing, and last-mile delay that does not scale with distance. */
  fixedOverheadMs: 10
};

/** Estimated round-trip latency in milliseconds for a distance, rounded to whole milliseconds. */
export function estimatedLatencyMsForDistanceKm(distanceKm: number) {
  if (!Number.isFinite(distanceKm) || distanceKm < 0) return undefined;
  const oneWayMs = (distanceKm * latencyModel.routePathFactor) / latencyModel.fibrePropagationKmPerMs;
  return Math.round(oneWayMs * 2 + latencyModel.fixedOverheadMs);
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
