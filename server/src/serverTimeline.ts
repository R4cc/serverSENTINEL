import type {
  ResourceStatsSample
} from "./resourceStatsCollector.js";
import type {
  ScheduledActiveRun,
  ScheduledExecution,
  ScheduledRun,
  ServerTimelineResourcePoint,
  ServerTimelineScheduleMarker
} from "./types.js";
import { nextCronRun } from "./core.js";

// The collector targets five-second samples, but remote node calls can occasionally
// arrive late without the underlying stats becoming unavailable. Only break the
// chart after six missed collection intervals so normal transport jitter does not
// turn otherwise continuous resource series into a dotted-looking line.
const gapThresholdMs = 30_000;

function finite(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function rate(current: number | undefined, previous: number | undefined, elapsedSeconds: number) {
  if (current === undefined || previous === undefined || elapsedSeconds <= 0 || current < previous) return null;
  return (current - previous) / elapsedSeconds;
}

function utilizationPercent(value: number, capacity: number | undefined) {
  if (!Number.isFinite(value) || !Number.isFinite(capacity) || !capacity || capacity <= 0) return null;
  return Math.max(0, Math.min(100, value / capacity));
}

function point(
  sample: ResourceStatsSample,
  previous?: ResourceStatsSample,
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
    networkRxBytesPerSecond: ratesValid ? rate(sample.networkRxBytes, previous.networkRxBytes, elapsedMs / 1000) : null,
    networkTxBytesPerSecond: ratesValid ? rate(sample.networkTxBytes, previous.networkTxBytes, elapsedMs / 1000) : null
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
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index];
    const previous = samples[index - 1];
    if (sample.sampledAt > to) break;
    const containsLongGap = Boolean(previous && sample.sampledAt - previous.sampledAt > gapThresholdMs);
    if (containsLongGap || !sample.available || !sample.running) cachedPlayersOnline = null;
    const current = point(sample, previous, cpuCapacityCores, cachedPlayersOnline);
    if (current.playersOnline !== null) cachedPlayersOnline = current.playersOnline;
    if (sample.sampledAt < from) continue;
    if (containsLongGap) {
      output.push({
        sampledAt: Math.max(from, previous.sampledAt + 5_000),
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

export function timelineScheduleMarkers(input: {
  schedules: ScheduledExecution[];
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
    if (!Number.isFinite(occurredAt) || occurredAt < input.from || occurredAt > input.to) continue;
    if (!add({ id: `active:${run.id}`, scheduleId: run.scheduleId, scheduleName: run.scheduleName, occurredAt, kind: "active", status: "running", runId: run.id, message: run.message })) break;
  }
  const upcomingFrom = Math.max(input.from, now);
  for (const schedule of input.schedules) {
    if (!schedule.enabled || markers.length >= limit) continue;
    let cursor = new Date(upcomingFrom - 60_000);
    while (markers.length < limit) {
      const next = nextCronRun(schedule.cron, cursor, 2);
      if (!next) break;
      const occurredAt = next.getTime();
      if (occurredAt > input.to) break;
      if (occurredAt >= upcomingFrom) {
        add({ id: `upcoming:${schedule.id}:${occurredAt}`, scheduleId: schedule.id, scheduleName: schedule.name, occurredAt, kind: "upcoming", status: "upcoming" });
      }
      cursor = next;
    }
    if (markers.length >= limit) truncated = true;
  }
  markers.sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
  return { markers, truncated };
}
