import {
  geoLite2Attribution,
  greatCircleDistanceKm,
  playerContinentNames,
  quietestWindow,
  type PlayerActivityHour,
  type PlayerContinentCode,
  type PlayerGeoDatabaseState,
  type PlayerInsightsEntry,
  type PlayerInsightsResponse,
  type PlayerInsightsServerLocation,
  type PlayerLatencyPoint,
  type PlayerLocation,
  type PlayerPingMeasurement,
  type PlayerRegionSummary
} from "@serversentinel/contracts";
import type { ResourceStatsSample } from "../resourceStatsCollector.js";
import { playerGeoKey, type StoredPlayerGeo } from "../storage/playerGeoRepository.js";
import type { ManagedServer, PlayerSnapshot } from "../types.js";

/**
 * Everything the Players workspace shows, assembled from what the panel already collects.
 *
 * Who is online comes from Minecraft Query, geography from the locally held GeoLite2 database,
 * activity from retained resource samples, and ping from the module-owned Linux TCP collector.
 * Connection endpoints never reach this assembler; it receives only player keys, current RTTs,
 * and bounded last-session averages.
 */

export type PlayerInsightsInput = {
  servers: ManagedServer[];
  snapshots: Record<string, PlayerSnapshot | undefined>;
  geo: StoredPlayerGeo[];
  serverLocations: PlayerInsightsServerLocation[];
  pings: Record<string, ReadonlyMap<string, number>>;
  pingMeasurements: PlayerPingMeasurement[];
  /** Retained resource samples per server; player counts and anonymous RTT arrays are read. */
  resourceSamples: Record<string, ResourceStatsSample[]>;
  geoDatabase: PlayerGeoDatabaseState;
  timeZone: string;
  /** How far back the measured ping series reaches; the browser chooses this with its range control. */
  historyWindowMs: number;
  /**
   * How far back the hour-of-day activity reaches, which is deliberately not the range control's
   * business: a maintenance window drawn from the last hour would recommend whatever hour it is.
   */
  activityWindowMs?: number;
  latencyPoints?: number;
  now?: number;
};

function onlineNames(snapshot: PlayerSnapshot | undefined) {
  if (!snapshot || (snapshot.state !== "live" && snapshot.state !== "stale")) return new Set<string>();
  return new Set(snapshot.names.map((name) => playerGeoKey(name)));
}

function locationDistanceKm(location: PlayerLocation | undefined, reference: PlayerLocation | undefined) {
  if (location?.latitude === undefined || location.longitude === undefined) return undefined;
  if (reference?.latitude === undefined || reference.longitude === undefined) return undefined;
  return Math.round(greatCircleDistanceKm(
    { latitude: location.latitude, longitude: location.longitude },
    { latitude: reference.latitude, longitude: reference.longitude }
  ));
}

function pingSummary(values: readonly number[]) {
  if (!values.length) return {};
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    medianPingMs: sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2),
    p95PingMs: sorted[Math.ceil(sorted.length * 0.95) - 1]
  };
}

export function playerInsightsEntries(input: Pick<PlayerInsightsInput, "servers" | "snapshots" | "geo" | "serverLocations" | "pings">) {
  const serverNames = new Map(input.servers.map((server) => [server.id, server.displayName]));
  const references = new Map(input.serverLocations.map((entry) => [entry.serverId, entry.location]));
  const online = new Map(input.servers.map((server) => [server.id, onlineNames(input.snapshots[server.id])]));
  const entries: PlayerInsightsEntry[] = [];
  const seen = new Set<string>();

  for (const stored of input.geo) {
    if (!serverNames.has(stored.serverId)) continue;
    const distanceKm = locationDistanceKm(stored.location, references.get(stored.serverId));
    const isOnline = online.get(stored.serverId)?.has(stored.playerKey) === true;
    const pingMs = isOnline ? input.pings[stored.serverId]?.get(stored.playerKey) : undefined;
    seen.add(`${stored.serverId}:${stored.playerKey}`);
    entries.push({
      player: stored.player,
      serverId: stored.serverId,
      serverName: serverNames.get(stored.serverId)!,
      online: isOnline,
      location: stored.location,
      ...(distanceKm !== undefined ? { distanceKm } : {}),
      ...(pingMs !== undefined ? { pingMs } : {}),
      ...(stored.lastPingAverageMs !== undefined ? { lastSessionAveragePingMs: stored.lastPingAverageMs } : {}),
      ...(stored.lastPingAt !== undefined ? { lastPingSampledAt: new Date(stored.lastPingAt).toISOString() } : {}),
      firstSeenAt: new Date(stored.firstSeenAt).toISOString(),
      lastSeenAt: new Date(stored.lastSeenAt).toISOString(),
      observations: stored.observations
    });
  }

  // Someone can be online without ever having produced a locatable login — a LAN player, a join
  // that predates the module, a database that was not loaded yet. They belong in the list with the
  // location left empty, because a player the panel can see and cannot place is exactly the case
  // the empty states are for.
  for (const server of input.servers) {
    const snapshot = input.snapshots[server.id];
    if (!snapshot || (snapshot.state !== "live" && snapshot.state !== "stale")) continue;
    for (const name of snapshot.names) {
      const key = playerGeoKey(name);
      if (!key || seen.has(`${server.id}:${key}`)) continue;
      seen.add(`${server.id}:${key}`);
      entries.push({
        player: name,
        serverId: server.id,
        serverName: server.displayName,
        online: true,
        ...(input.pings[server.id]?.get(key) !== undefined ? { pingMs: input.pings[server.id].get(key) } : {}),
        observations: 0
      });
    }
  }

  return entries.sort((left, right) => Number(right.online) - Number(left.online)
    || (right.lastSeenAt ?? "").localeCompare(left.lastSeenAt ?? "")
    || left.player.localeCompare(right.player));
}

export function playerRegionSummaries(entries: readonly PlayerInsightsEntry[]): PlayerRegionSummary[] {
  const byContinent = new Map<PlayerContinentCode, { players: number; online: number; latencies: number[] }>();
  let located = 0;
  for (const entry of entries) {
    const code = entry.location?.continentCode;
    if (!code) continue;
    located += 1;
    const bucket = byContinent.get(code) ?? { players: 0, online: 0, latencies: [] };
    bucket.players += 1;
    if (entry.online) bucket.online += 1;
    if (entry.online && entry.pingMs !== undefined) bucket.latencies.push(entry.pingMs);
    byContinent.set(code, bucket);
  }
  return [...byContinent.entries()]
    .map(([continentCode, bucket]) => ({
      continentCode,
      continent: playerContinentNames[continentCode],
      players: bucket.players,
      share: located ? bucket.players / located : 0,
      onlinePlayers: bucket.online,
      ...(bucket.latencies.length
        ? { averagePingMs: Math.round(bucket.latencies.reduce((total, value) => total + value, 0) / bucket.latencies.length) }
        : {})
    }))
    .sort((left, right) => right.players - left.players || left.continent.localeCompare(right.continent));
}

/** Measured TCP RTT history, downsampled from the existing retained resource samples. */
export function playerLatencyHistory(input: {
  resourceSamples: Record<string, ResourceStatsSample[]>;
  from: number;
  to: number;
  points: number;
}): PlayerLatencyPoint[] {
  if (input.points < 2 || input.to <= input.from) return [];
  const buckets = Array.from({ length: input.points }, () => new Map<string, ResourceStatsSample>());
  const span = input.to - input.from;
  for (const [serverId, samples] of Object.entries(input.resourceSamples)) {
    for (const sample of samples) {
      if (sample.sampledAt < input.from || sample.sampledAt > input.to) continue;
      const index = Math.min(input.points - 1, Math.floor(((sample.sampledAt - input.from) / span) * input.points));
      const previous = buckets[index].get(serverId);
      if (!previous || sample.sampledAt >= previous.sampledAt) buckets[index].set(serverId, sample);
    }
  }
  return buckets.map((byServer, index) => {
    const samples = [...byServer.values()];
    const pingMs = samples.flatMap((sample) => sample.playerPingMs?.filter((value) => Number.isFinite(value) && value > 0) ?? []);
    return {
      at: Math.round(input.from + (span * index) / (input.points - 1)),
      players: samples.reduce((total, sample) => total + (sample.playersOnline ?? 0), 0),
      measuredPlayers: pingMs.length,
      ...pingSummary(pingMs)
    };
  });
}

/**
 * Average and peak players per hour of the day, in the panel's own time zone.
 *
 * Read straight off the resource samples that already carry a player count, so this costs one
 * query per server and no new collection. An hour with no retained samples reports zero samples
 * rather than zero players, which is what stops a fresh installation from recommending a
 * maintenance window it has no evidence for.
 */
export function playerActivityHours(input: {
  resourceSamples: Record<string, ResourceStatsSample[]>;
  timeZone: string;
  from: number;
}): PlayerActivityHour[] {
  const hourFormatter = new Intl.DateTimeFormat("en-US", { timeZone: input.timeZone, hour12: false, hour: "2-digit" });
  const buckets = Array.from({ length: 24 }, () => ({ total: 0, peak: 0, samples: 0 }));
  const samplesByInstant = new Map<number, Map<string, { sampledAt: number; players: number }>>();

  for (const [serverId, samples] of Object.entries(input.resourceSamples)) {
    for (const sample of samples) {
      if (sample.sampledAt < input.from || typeof sample.playersOnline !== "number") continue;
      // Several servers sampled at nearly the same moment describe one population, so they are
      // summed per ten-second slot before being averaged rather than averaged separately. A server
      // can be sampled twice inside one slot, so only its newest observation belongs in that total.
      const slot = Math.round(sample.sampledAt / 10_000) * 10_000;
      const byServer = samplesByInstant.get(slot) ?? new Map<string, { sampledAt: number; players: number }>();
      const previous = byServer.get(serverId);
      if (!previous || sample.sampledAt >= previous.sampledAt) {
        byServer.set(serverId, { sampledAt: sample.sampledAt, players: sample.playersOnline });
      }
      samplesByInstant.set(slot, byServer);
    }
  }

  for (const [slot, byServer] of samplesByInstant) {
    const players = [...byServer.values()].reduce((total, sample) => total + sample.players, 0);
    const hour = Number.parseInt(hourFormatter.format(new Date(slot)), 10);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    const bucket = buckets[hour];
    bucket.total += players;
    bucket.samples += 1;
    if (players > bucket.peak) bucket.peak = players;
  }

  return buckets.map((bucket, hour) => ({
    hour,
    averagePlayers: bucket.samples ? bucket.total / bucket.samples : 0,
    peakPlayers: bucket.peak,
    samples: bucket.samples
  }));
}

export function buildPlayerInsights(input: PlayerInsightsInput): PlayerInsightsResponse {
  const now = input.now ?? Date.now();
  const from = now - input.historyWindowMs;
  const entries = playerInsightsEntries(input);
  const regions = playerRegionSummaries(entries);
  const onlineEntries = entries.filter((entry) => entry.online);
  const onlinePings = onlineEntries
    .map((entry) => entry.pingMs)
    .filter((value): value is number => value !== undefined);

  const activityHours = playerActivityHours({
    resourceSamples: input.resourceSamples,
    timeZone: input.timeZone,
    from: now - (input.activityWindowMs ?? input.historyWindowMs)
  });
  const maintenanceWindow = quietestWindow(activityHours);
  const countries = new Set(entries.map((entry) => entry.location?.countryCode).filter(Boolean));
  const currentPing = pingSummary(onlinePings);

  return {
    generatedAt: new Date(now).toISOString(),
    timeZone: input.timeZone,
    summary: {
      ...currentPing,
      countries: countries.size,
      onlinePlayers: onlineEntries.length,
      locatedPlayers: entries.filter((entry) => entry.location).length,
      knownPlayers: entries.length,
      ...(regions[0] ? { mostActiveRegion: regions[0] } : {}),
      ...(maintenanceWindow ? { maintenanceWindow } : {})
    },
    players: entries,
    regions,
    latency: playerLatencyHistory({
      resourceSamples: input.resourceSamples,
      from,
      to: now,
      points: input.latencyPoints ?? 96
    }),
    pingMeasurements: input.pingMeasurements,
    activityHours,
    serverLocations: input.serverLocations,
    geoDatabase: input.geoDatabase,
    attribution: geoLite2Attribution
  };
}
