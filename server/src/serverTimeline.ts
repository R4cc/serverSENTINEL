import type {
  ResourceStatsSample
} from "./resourceStatsCollector.js";
import type {
  ScheduledActiveRun,
  ScheduledRun,
  PlayerSnapshot,
  ServerTimelineEvent,
  ServerTimelinePlayerActivity,
  ServerTimelinePlayerSession,
  ServerTimelineResourcePoint,
  ServerTimelineScheduleMarker
} from "./types.js";

// The collector targets five-second samples, but remote node calls can occasionally
// arrive late without the underlying stats becoming unavailable. Only break the
// chart after six missed collection intervals so normal transport jitter does not
// turn otherwise continuous resource series into a dotted-looking line.
const gapThresholdMs = 30_000;

function playerKey(value: string) {
  return value.trim().toLocaleLowerCase();
}

export function timelinePlayerIsKnown(events: ServerTimelineEvent[], playerName: string) {
  const key = playerKey(playerName);
  return Boolean(key) && events.some((event) =>
    (event.eventType === "player_joined" || event.eventType === "player_left")
    && typeof event.subject === "string"
    && playerKey(event.subject) === key
  );
}

function timelineSnapshotAt(snapshot: PlayerSnapshot | undefined) {
  if (!snapshot) return undefined;
  if (snapshot.state === "live" || snapshot.state === "stale" || snapshot.state === "stopped") return snapshot.sampledAt;
  return snapshot.lastAttemptAt;
}

export function timelinePlayerActivity(input: {
  events: ServerTimelineEvent[];
  snapshot?: PlayerSnapshot;
  contextFrom: number;
  from: number;
  to: number;
  now?: number;
}): ServerTimelinePlayerActivity {
  const now = input.now ?? Date.now();
  const currentBoundary = Math.max(input.contextFrom, Math.min(now, input.to));
  const displayNames = new Map<string, string>();
  const open = new Map<string, { player: string; startedAt: number; startBoundary: ServerTimelinePlayerSession["startBoundary"] }>();
  const seenPlayers = new Set<string>();
  const sessions: ServerTimelinePlayerSession[] = [];
  const rememberName = (value: string) => {
    const player = value.trim();
    const key = playerKey(player);
    if (player && !displayNames.has(key)) displayNames.set(key, player);
    return { key, player: displayNames.get(key) ?? player };
  };
  const close = (key: string, endedAt: number, endBoundary: ServerTimelinePlayerSession["endBoundary"]) => {
    const active = open.get(key);
    if (!active || endedAt < active.startedAt) return;
    sessions.push({
      id: `${key}:${active.startedAt}:${active.startBoundary}`,
      player: active.player,
      startedAt: active.startedAt,
      endedAt,
      startBoundary: active.startBoundary,
      endBoundary
    });
    open.delete(key);
  };

  // Nobody can have been online before the server last came up, so a session with an
  // unknown start is bounded by the newest start event rather than by the raw history
  // window.
  let historyBoundary = input.contextFrom;

  const events = [...input.events]
    .filter((event) => event.occurredAt >= input.contextFrom && event.occurredAt <= input.to)
    .sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
  for (const event of events) {
    if (event.eventType === "server_started") {
      for (const key of [...open.keys()]) close(key, event.occurredAt, "server-end");
      historyBoundary = Math.max(historyBoundary, event.occurredAt);
      continue;
    }
    if (event.eventType === "server_stopped" || event.eventType === "server_crashed") {
      for (const key of [...open.keys()]) close(key, event.occurredAt, "server-end");
      continue;
    }
    if (event.eventType !== "player_joined" && event.eventType !== "player_left") continue;
    const subject = event.subject?.trim();
    if (!subject) continue;
    const { key, player } = rememberName(subject);
    if (event.eventType === "player_joined") {
      if (!open.has(key)) open.set(key, { player, startedAt: event.occurredAt, startBoundary: "join" });
      seenPlayers.add(key);
      continue;
    }
    if (!open.has(key) && seenPlayers.has(key)) continue;
    if (!open.has(key)) open.set(key, { player, startedAt: historyBoundary, startBoundary: "history-boundary" });
    close(key, event.occurredAt, "leave");
    seenPlayers.add(key);
  }

  const currentSnapshot = input.snapshot?.state === "live" || input.snapshot?.state === "stale" ? input.snapshot : undefined;
  const onlineByKey = new Map<string, string>();
  if (currentSnapshot) {
    for (const name of currentSnapshot.names) {
      const remembered = rememberName(name);
      onlineByKey.set(remembered.key, remembered.player);
    }
    const sampledAt = Date.parse(currentSnapshot.sampledAt);
    if (Number.isFinite(sampledAt)) {
      for (const event of events) {
        if (event.occurredAt <= sampledAt) continue;
        if (event.eventType === "server_started" || event.eventType === "server_stopped" || event.eventType === "server_crashed") {
          onlineByKey.clear();
          continue;
        }
        if ((event.eventType !== "player_joined" && event.eventType !== "player_left") || !event.subject?.trim()) continue;
        const remembered = rememberName(event.subject);
        if (event.eventType === "player_joined") onlineByKey.set(remembered.key, remembered.player);
        else onlineByKey.delete(remembered.key);
      }
    }
  }
  const onlineNames = [...onlineByKey.values()];
  const onlineKeys = new Set(onlineNames.map(playerKey));
  const lastSessionEndByKey = new Map<string, number | null>();
  for (const session of sessions) lastSessionEndByKey.set(playerKey(session.player), session.endedAt);
  for (const player of onlineNames) {
    const key = playerKey(player);
    if (!open.has(key)) {
      const lastEnd = lastSessionEndByKey.get(key);
      open.set(key, {
        player,
        startedAt: Math.min(currentBoundary, Math.max(historyBoundary, lastEnd ?? historyBoundary)),
        startBoundary: "history-boundary"
      });
    }
  }
  for (const [key, active] of open) {
    if (onlineKeys.has(key)) {
      sessions.push({
        id: `${key}:${active.startedAt}:${active.startBoundary}`,
        player: active.player,
        startedAt: active.startedAt,
        endedAt: null,
        startBoundary: active.startBoundary,
        endBoundary: "online"
      });
    } else {
      close(key, currentBoundary, "history-boundary");
    }
  }

  const visibleSessions = sessions
    .filter((session) => session.startedAt <= input.to && (session.endedAt ?? now) >= input.from)
    .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id));
  return {
    snapshotState: input.snapshot?.state ?? "unavailable",
    sampledAt: timelineSnapshotAt(input.snapshot),
    onlineNames,
    sessions: visibleSessions
  };
}

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rate(current: number | undefined, previous: number | undefined, elapsedSeconds: number) {
  if (current === undefined || previous === undefined || elapsedSeconds <= 0 || current < previous) return null;
  return (current - previous) / elapsedSeconds;
}

type NetworkRates = { rx: number | null; tx: number | null };

const unknownNetworkRates: NetworkRates = { rx: null, tx: null };

/**
 * Milliseconds between two network counter readings, measured on the clock that took them.
 *
 * `readAt` is stamped when the container stats were actually read; `sampledAt` is stamped when the
 * panel filed the sample. For a local container those coincide, but a remote node serves stats from
 * a cached observation, so several collections can share one stats read and a counter delta does
 * not cover the interval between collections. Dividing by the collection interval reported a rate
 * of zero for the repeated read and roughly double the true rate for the one that followed it.
 */
function readingIntervalMs(sample: ResourceStatsSample, baseline: ResourceStatsSample) {
  const current = Date.parse(sample.readAt);
  const previous = Date.parse(baseline.readAt);
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return sample.sampledAt - baseline.sampledAt;
  return current - previous;
}

function networkRates(sample: ResourceStatsSample, baseline: ResourceStatsSample | undefined, held: NetworkRates): NetworkRates {
  if (!baseline || sample.sampledAt - baseline.sampledAt > gapThresholdMs) return unknownNetworkRates;
  const elapsedMs = readingIntervalMs(sample, baseline);
  // The counters were never re-read, so they cannot have advanced. Holding the last measured rate
  // keeps the series continuous instead of claiming the server went quiet.
  if (elapsedMs === 0) return held;
  if (elapsedMs < 0) return unknownNetworkRates;
  return {
    rx: rate(sample.networkRxBytes, baseline.networkRxBytes, elapsedMs / 1000),
    tx: rate(sample.networkTxBytes, baseline.networkTxBytes, elapsedMs / 1000)
  };
}

function utilizationPercent(value: number, capacity: number | undefined) {
  if (!Number.isFinite(value) || !Number.isFinite(capacity) || !capacity || capacity <= 0) return null;
  return Math.max(0, Math.min(100, value / capacity));
}

function point(
  sample: ResourceStatsSample,
  previous: ResourceStatsSample | undefined,
  rates: NetworkRates,
  fallbackCpuCapacityCores?: number,
  cachedPlayersOnline: number | null = null
): ServerTimelineResourcePoint {
  const valid = sample.available && sample.running;
  const elapsedMs = previous ? sample.sampledAt - previous.sampledAt : 0;
  const ratesValid = valid && previous?.available && previous.running && elapsedMs > 0 && elapsedMs <= gapThresholdMs;
  const verifiedPlayersOnline = finite(sample.playersOnline);
  return {
    sampledAt: sample.sampledAt,
    available: sample.available,
    running: sample.running,
    cpuPercent: valid ? finite(sample.cpuPercent) : null,
    cpuUtilizationPercent: valid ? utilizationPercent(sample.cpuPercent, sample.cpuCapacityCores ?? fallbackCpuCapacityCores) : null,
    memoryUsageBytes: valid ? finite(sample.memoryUsageBytes) : null,
    memoryLimitBytes: valid ? finite(sample.memoryLimitBytes) : null,
    memoryUtilizationPercent: valid ? utilizationPercent(sample.memoryUsageBytes * 100, sample.memoryLimitBytes) : null,
    playersOnline: valid ? verifiedPlayersOnline ?? cachedPlayersOnline : null,
    networkRxBytesPerSecond: ratesValid ? rates.rx : null,
    networkTxBytesPerSecond: ratesValid ? rates.tx : null
  };
}

function average(values: Array<number | null>) {
  const valid = values.filter((value): value is number => value !== null && Number.isFinite(value));
  return valid.length ? valid.reduce((total, value) => total + value, 0) / valid.length : null;
}

function completeAverage(values: Array<number | null>) {
  return values.some((value) => value === null) ? null : average(values);
}

function aggregate(points: ServerTimelineResourcePoint[], maxPoints: number) {
  if (points.length <= maxPoints) return points;
  const bucketSize = Math.ceil(points.length / maxPoints);
  const output: ServerTimelineResourcePoint[] = [];
  for (let index = 0; index < points.length; index += bucketSize) {
    const bucket = points.slice(index, index + bucketSize);
    const containsGap = bucket.some((item) => !item.available || !item.running);
    const lastPlayersOnline = [...bucket].reverse().find((item) => item.playersOnline !== null)?.playersOnline ?? null;
    output.push({
      sampledAt: Math.round(average(bucket.map((item) => item.sampledAt)) ?? bucket[0].sampledAt),
      available: !containsGap,
      running: !containsGap,
      cpuPercent: containsGap ? null : completeAverage(bucket.map((item) => item.cpuPercent)),
      cpuUtilizationPercent: containsGap ? null : completeAverage(bucket.map((item) => item.cpuUtilizationPercent)),
      memoryUsageBytes: containsGap ? null : completeAverage(bucket.map((item) => item.memoryUsageBytes)),
      memoryLimitBytes: containsGap ? null : completeAverage(bucket.map((item) => item.memoryLimitBytes)),
      memoryUtilizationPercent: containsGap ? null : completeAverage(bucket.map((item) => item.memoryUtilizationPercent)),
      playersOnline: containsGap ? null : lastPlayersOnline,
      networkRxBytesPerSecond: containsGap ? null : completeAverage(bucket.map((item) => item.networkRxBytesPerSecond)),
      networkTxBytesPerSecond: containsGap ? null : completeAverage(bucket.map((item) => item.networkTxBytesPerSecond))
    });
  }
  return output;
}

export function timelineResourcePoints(samples: ResourceStatsSample[], from: number, to: number, maxPoints: number, fallbackCpuCapacityCores?: number) {
  const output: ServerTimelineResourcePoint[] = [];
  const cpuCapacityCores = [...samples].reverse().find((sample) => sample.cpuCapacityCores)?.cpuCapacityCores ?? fallbackCpuCapacityCores;
  let cachedPlayersOnline: number | null = null;
  // The last sample whose counters came from a distinct stats read, plus the rate it produced.
  // Rates are measured against that reading rather than the previous sample so a repeated remote
  // observation neither reports a false zero nor doubles the rate of the collection after it.
  let networkBaseline: ResourceStatsSample | undefined;
  let heldNetworkRates = unknownNetworkRates;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const previous = samples[index - 1];
    if (sample.sampledAt > to) break;
    const containsLongGap = Boolean(previous && sample.sampledAt - previous.sampledAt > gapThresholdMs);
    const running = sample.available && sample.running;
    if (containsLongGap || !running) {
      cachedPlayersOnline = null;
      networkBaseline = undefined;
      heldNetworkRates = unknownNetworkRates;
    }
    const rates = networkRates(sample, networkBaseline, heldNetworkRates);
    if (running) {
      if (!networkBaseline || readingIntervalMs(sample, networkBaseline) !== 0) networkBaseline = sample;
      heldNetworkRates = rates;
    }
    const current = point(sample, previous, rates, cpuCapacityCores, cachedPlayersOnline);
    if (current.playersOnline !== null) cachedPlayersOnline = current.playersOnline;
    if (sample.sampledAt < from) continue;
    if (containsLongGap) {
      const gapAt = Math.max(from, previous.sampledAt + 5_000);
      if (gapAt < sample.sampledAt) {
        output.push({
          sampledAt: gapAt,
          available: false,
          running: false,
          cpuPercent: null,
          cpuUtilizationPercent: null,
          memoryUsageBytes: null,
          memoryLimitBytes: null,
          memoryUtilizationPercent: null,
          playersOnline: null,
          networkRxBytesPerSecond: null,
          networkTxBytesPerSecond: null
        });
      }
    }
    output.push(current);
  }
  return aggregate(output, maxPoints);
}

function runStatus(status: string): ServerTimelineScheduleMarker["status"] {
  const normalized = status.toLowerCase();
  if (normalized === "success" || normalized === "succeeded" || normalized === "completed") return "success";
  if (normalized === "failed") return "failed";
  if (normalized === "skipped") return "skipped";
  if (normalized === "cancelled") return "cancelled";
  return "unknown";
}

/**
 * Schedule annotations for a timeline window.
 *
 * Only runs that already started are projected. The viewport is clamped to the present, so a
 * window that contains a future cron occurrence cannot be requested; the Schedules panel is where
 * upcoming runs are listed.
 */
export function timelineScheduleMarkers(input: {
  runs: ScheduledRun[];
  activeRuns: ScheduledActiveRun[];
  from: number;
  to: number;
  now?: number;
  limit?: number;
}) {
  const now = input.now ?? Date.now();
  const limit = input.limit ?? 2_000;
  const markers: ServerTimelineScheduleMarker[] = [];
  let truncated = false;
  const add = (marker: ServerTimelineScheduleMarker) => {
    if (markers.length >= limit) {
      truncated = true;
      return false;
    }
    markers.push(marker);
    return true;
  };

  for (const run of input.runs) {
    const occurredAt = new Date(run.ranAt).getTime();
    if (!Number.isFinite(occurredAt) || occurredAt < input.from || occurredAt > input.to) continue;
    if (!add({ id: `run:${run.id}`, scheduleId: run.scheduleId, scheduleName: run.scheduleName, occurredAt, kind: "run", status: runStatus(run.status), runId: run.id, message: run.message })) break;
  }
  for (const run of input.activeRuns) {
    const occurredAt = new Date(run.startedAt).getTime();
    // Active runs are open intervals. Keep them in every window they overlap,
    // including when they began before the current viewport.
    if (!Number.isFinite(occurredAt) || occurredAt > input.to || now < input.from) continue;
    if (!add({ id: `active:${run.id}`, scheduleId: run.scheduleId, scheduleName: run.scheduleName, occurredAt, kind: "active", status: "running", runId: run.id, message: run.message })) break;
  }
  markers.sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
  return { markers, truncated };
}
