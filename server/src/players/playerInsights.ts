import {
  estimatedLatencyMsForDistanceKm,
  geoLite2Attribution,
  greatCircleDistanceKm,
  medianOf,
  percentileOf,
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
  type PlayerRegionSummary
} from "@serversentinel/contracts";
import type { ResourceStatsSample } from "../resourceStatsCollector.js";
import { timelinePlayerActivity } from "../serverTimeline.js";
import { playerGeoKey, type StoredPlayerGeo, type StoredPlayerGeoStint } from "../storage/playerGeoRepository.js";
import type { ManagedServer, PlayerSnapshot, ServerTimelineEvent } from "../types.js";

/**
 * Everything the Players workspace shows, assembled from what the panel already collects.
 *
 * Nothing here is a new measurement. Who is online comes from the Minecraft Query observation the
 * panel polls anyway; who played when comes from the join and leave events the timeline collector
 * already files; how busy each hour is comes from the player counts already sampled alongside CPU
 * and memory. The only thing this module adds is where those players are, and even that is a
 * lookup rather than a probe.
 *
 * Latency is the one figure that is not observed at all. No protocol the panel speaks reports a
 * player's own round-trip time, so it is estimated from the distance between two approximate
 * positions and named `estimated` everywhere it appears. When either position is unknown the field
 * is absent rather than guessed, which is why so much of this file is written as "when known".
 */

export type PlayerInsightsInput = {
  servers: ManagedServer[];
  snapshots: Record<string, PlayerSnapshot | undefined>;
  geo: StoredPlayerGeo[];
  serverLocations: PlayerInsightsServerLocation[];
  /** Retained join and leave history per server, used to reconstruct who was online when. */
  timelineEvents: Record<string, ServerTimelineEvent[]>;
  /** Retained resource samples per server; only their player counts are read. */
  resourceSamples: Record<string, ResourceStatsSample[]>;
  geoDatabase: PlayerGeoDatabaseState;
  timeZone: string;
  /** How far back the latency series reaches; the browser chooses this with its range control. */
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

/**
 * Where a player was at a given moment, as far as the panel recorded.
 *
 * The run that had already begun by then, which is the last observation before that moment. Before
 * the first run there is no answer and none is invented: guessing forward from a later observation
 * is exactly the mistake that let one player moving rewrite a week of history.
 */
export function stintAt(stints: readonly StoredPlayerGeoStint[], at: number): StoredPlayerGeoStint | undefined {
  let current: StoredPlayerGeoStint | undefined;
  for (const stint of stints) {
    if (stint.firstSeenAt > at) break;
    current = stint;
  }
  return current;
}

export function playerInsightsEntries(input: Pick<PlayerInsightsInput, "servers" | "snapshots" | "geo" | "serverLocations">) {
  const serverNames = new Map(input.servers.map((server) => [server.id, server.displayName]));
  const references = new Map(input.serverLocations.map((entry) => [entry.serverId, entry.location]));
  const online = new Map(input.servers.map((server) => [server.id, onlineNames(input.snapshots[server.id])]));
  const entries: PlayerInsightsEntry[] = [];
  const seen = new Set<string>();

  for (const stored of input.geo) {
    if (!serverNames.has(stored.serverId)) continue;
    const distanceKm = locationDistanceKm(stored.location, references.get(stored.serverId));
    const estimatedLatencyMs = distanceKm === undefined ? undefined : estimatedLatencyMsForDistanceKm(distanceKm);
    seen.add(`${stored.serverId}:${stored.playerKey}`);
    entries.push({
      player: stored.player,
      serverId: stored.serverId,
      serverName: serverNames.get(stored.serverId)!,
      online: online.get(stored.serverId)?.has(stored.playerKey) === true,
      location: stored.location,
      ...(distanceKm !== undefined ? { distanceKm } : {}),
      ...(estimatedLatencyMs !== undefined ? { estimatedLatencyMs } : {}),
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
    if (entry.estimatedLatencyMs !== undefined) bucket.latencies.push(entry.estimatedLatencyMs);
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
        ? { averageEstimatedLatencyMs: Math.round(bucket.latencies.reduce((total, value) => total + value, 0) / bucket.latencies.length) }
        : {})
    }))
    .sort((left, right) => right.players - left.players || left.continent.localeCompare(right.continent));
}

/**
 * Estimated latency over time, reconstructed rather than recorded.
 *
 * The panel never sampled a latency series, but it did record when every player joined and left,
 * and roughly where each of them was at the time. Replaying those sessions across the window gives
 * the population at each instant, and the population gives the estimate.
 *
 * "At the time" is the part that has to be got right. Each session is measured against the place
 * the player was in when it started, not the place they are in now: with only a latest location to
 * hand, one player moving between continents retroactively rewrote every hour of this chart. A
 * session that began before the panel ever placed that player contributes to the player count and
 * to nothing else, because the honest answer to "how far away were they in April" is that nobody
 * recorded it.
 */
export function playerLatencyHistory(input: {
  servers: ManagedServer[];
  snapshots: Record<string, PlayerSnapshot | undefined>;
  timelineEvents: Record<string, ServerTimelineEvent[]>;
  /** Per player, the runs of joins the panel recorded, oldest first. */
  historyByPlayer: Map<string, readonly StoredPlayerGeoStint[]>;
  /** Where each server is measured from; absent for a server with no configured address. */
  referenceByServer: Map<string, PlayerLocation | undefined>;
  from: number;
  contextFrom?: number;
  to: number;
  points: number;
  now?: number;
}): PlayerLatencyPoint[] {
  const now = input.now ?? Date.now();
  const sessions: Array<{ key: string; serverId: string; startedAt: number; endedAt: number }> = [];
  for (const server of input.servers) {
    const activity = timelinePlayerActivity({
      events: input.timelineEvents[server.id] ?? [],
      snapshot: input.snapshots[server.id],
      contextFrom: input.contextFrom ?? input.from,
      from: input.from,
      to: input.to,
      now
    });
    for (const session of activity.sessions) {
      sessions.push({
        key: `${server.id}:${playerGeoKey(session.player)}`,
        serverId: server.id,
        startedAt: session.startedAt,
        endedAt: session.endedAt ?? Math.min(now, input.to)
      });
    }
  }
  if (input.points < 2 || input.to <= input.from) return [];

  // A session's latency cannot change while it is open, so it is resolved once here rather than
  // once per plotted point.
  const sessionLatency = new Map<(typeof sessions)[number], number | undefined>();
  for (const session of sessions) {
    const stint = stintAt(input.historyByPlayer.get(session.key) ?? [], session.startedAt);
    const distanceKm = locationDistanceKm(stint?.location, input.referenceByServer.get(session.serverId));
    sessionLatency.set(session, distanceKm === undefined ? undefined : estimatedLatencyMsForDistanceKm(distanceKm));
  }

  const step = (input.to - input.from) / (input.points - 1);
  const series: PlayerLatencyPoint[] = [];
  for (let index = 0; index < input.points; index += 1) {
    const at = Math.round(input.from + step * index);
    const latencies: number[] = [];
    let players = 0;
    for (const session of sessions) {
      if (session.startedAt > at || session.endedAt < at) continue;
      players += 1;
      const latency = sessionLatency.get(session);
      if (latency !== undefined) latencies.push(latency);
    }
    series.push({
      at,
      players,
      ...(latencies.length ? { medianEstimatedLatencyMs: medianOf(latencies) } : {}),
      ...(latencies.length ? { p95EstimatedLatencyMs: percentileOf(latencies, 95) } : {})
    });
  }
  return series;
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
  const onlineLatencies = onlineEntries
    .map((entry) => entry.estimatedLatencyMs)
    .filter((value): value is number => value !== undefined);
  // With nobody online the headline still has something honest to say: the same estimate across
  // everyone this server has seen, which is what the regional table is describing anyway.
  const latencies = onlineLatencies.length
    ? onlineLatencies
    : entries.map((entry) => entry.estimatedLatencyMs).filter((value): value is number => value !== undefined);

  const historyByPlayer = new Map<string, readonly StoredPlayerGeoStint[]>(
    input.geo.map((stored) => [`${stored.serverId}:${stored.playerKey}`, stored.stints])
  );
  const referenceByServer = new Map<string, PlayerLocation | undefined>(
    input.serverLocations.map((entry) => [entry.serverId, entry.location])
  );

  const activityHours = playerActivityHours({
    resourceSamples: input.resourceSamples,
    timeZone: input.timeZone,
    from: now - (input.activityWindowMs ?? input.historyWindowMs)
  });
  const maintenanceWindow = quietestWindow(activityHours);
  const countries = new Set(entries.map((entry) => entry.location?.countryCode).filter(Boolean));
  const medianEstimatedLatencyMs = medianOf(latencies);
  const p95EstimatedLatencyMs = percentileOf(latencies, 95);

  return {
    generatedAt: new Date(now).toISOString(),
    timeZone: input.timeZone,
    summary: {
      ...(medianEstimatedLatencyMs !== undefined ? { medianEstimatedLatencyMs } : {}),
      ...(p95EstimatedLatencyMs !== undefined ? { p95EstimatedLatencyMs } : {}),
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
      servers: input.servers,
      snapshots: input.snapshots,
      timelineEvents: input.timelineEvents,
      historyByPlayer,
      referenceByServer,
      from,
      contextFrom: now - (input.activityWindowMs ?? input.historyWindowMs),
      to: now,
      points: input.latencyPoints ?? 96,
      now
    }),
    activityHours,
    serverLocations: input.serverLocations,
    geoDatabase: input.geoDatabase,
    attribution: geoLite2Attribution
  };
}
