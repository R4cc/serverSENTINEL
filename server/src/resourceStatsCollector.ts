import type { ManagedServer } from "./types.js";
import type { NodeRuntime } from "./nodes/types.js";
import type { ResourceStatsRepository } from "./storage/resourceStatsRepository.js";

export type ResourceStatsSample = {
  available: boolean;
  running: boolean;
  cpuPercent: number;
  cpuCapacityCores?: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  playersOnline?: number;
  /** Anonymous measured TCP RTT values retained for the Player Insights history chart. */
  playerPingMs?: number[];
  networkRxBytes?: number;
  networkTxBytes?: number;
  readAt: string;
  container?: string;
  message?: string;
  sampledAt: number;
};

type ResourceStatsHistory = {
  samples: ResourceStatsSample[];
};

const defaultHistoryWindowMs = 60 * 60 * 1000;

type CollectorOptions = {
  pollMs: number;
  historyWindowMs: number;
  readServers: () => Promise<ManagedServer[]>;
  isServerActive?: (serverId: string) => boolean;
  runtimeForServer: (server: ManagedServer) => NodeRuntime;
  statsRepository: ResourceStatsRepository;
  decorateSample?: (server: ManagedServer, sample: ResourceStatsSample) => ResourceStatsSample;
};

function finiteNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function optionalFiniteNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeStats(value: unknown, sampledAt = Date.now()): ResourceStatsSample {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const readAt = typeof record.readAt === "string"
    ? record.readAt
    : typeof record.sampledAt === "string"
      ? record.sampledAt
      : new Date(sampledAt).toISOString();
  const sample: ResourceStatsSample = {
    available: record.available === true,
    running: record.running === true,
    cpuPercent: Math.max(0, finiteNumber(record.cpuPercent)),
    memoryUsageBytes: Math.max(0, finiteNumber(record.memoryUsageBytes)),
    memoryLimitBytes: Math.max(0, finiteNumber(record.memoryLimitBytes)),
    readAt,
    sampledAt
  };
  const cpuCapacityCores = optionalFiniteNumber(record.cpuCapacityCores);
  const playersOnline = optionalFiniteNumber(record.playersOnline);
  if (cpuCapacityCores !== undefined && cpuCapacityCores > 0) sample.cpuCapacityCores = cpuCapacityCores;
  if (playersOnline !== undefined && playersOnline >= 0) sample.playersOnline = Math.floor(playersOnline);
  const networkRxBytes = optionalFiniteNumber(record.networkRxBytes);
  const networkTxBytes = optionalFiniteNumber(record.networkTxBytes);
  if (networkRxBytes !== undefined) sample.networkRxBytes = Math.max(0, networkRxBytes);
  if (networkTxBytes !== undefined) sample.networkTxBytes = Math.max(0, networkTxBytes);
  if (typeof record.container === "string") sample.container = record.container;
  if (typeof record.message === "string") sample.message = record.message;
  return sample;
}

function unavailableSample(message: string, sampledAt = Date.now()): ResourceStatsSample {
  return {
    available: false,
    running: false,
    cpuPercent: 0,
    memoryUsageBytes: 0,
    memoryLimitBytes: 0,
    readAt: new Date(sampledAt).toISOString(),
    message,
    sampledAt
  };
}

export class ResourceStatsCollector {
  private readonly inFlight = new Map<string, Promise<ResourceStatsSample>>();
  private interval: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly options: CollectorOptions) {}

  start() {
    if (this.interval || this.closed) return;
    try {
      this.options.statsRepository.prune(Date.now() - this.options.historyWindowMs);
    } catch {
      // A failed startup prune must not prevent live collection.
    }
    void this.collectAll().catch(() => undefined);
    this.interval = setInterval(() => void this.collectAll().catch(() => undefined), this.options.pollMs);
    this.interval.unref?.();
  }

  stop() {
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
  }

  async collectAll() {
    if (this.closed) return;
    const servers = await this.options.readServers();
    if (this.closed) return;
    await Promise.allSettled(servers.map((server) => this.collectServer(server)));
  }

  async collectServer(server: ManagedServer) {
    const existing = this.inFlight.get(server.id);
    if (existing) return existing;
    const request = this.collectServerOnce(server).finally(() => {
      this.inFlight.delete(server.id);
    });
    this.inFlight.set(server.id, request);
    return request;
  }

  async history(server: ManagedServer, windowMs = defaultHistoryWindowMs): Promise<ResourceStatsHistory> {
    const repository = this.options.statsRepository;
    const latest = repository.latest(server.id);
    const recentCutoff = Date.now() - Math.min(defaultHistoryWindowMs, this.options.historyWindowMs);
    const latestAt = latest && latest.sampledAt >= recentCutoff
      ? latest.sampledAt
      : (await this.collectServer(server)).sampledAt;
    return { samples: repository.list(server.id, latestAt - windowMs) };
  }

  private async collectServerOnce(server: ManagedServer) {
    const sampledAt = Date.now();
    let sample: ResourceStatsSample;
    if (this.closed || this.options.isServerActive?.(server.id) === false) return unavailableSample("Collection stopped", sampledAt);
    try {
      const stats = await this.options.runtimeForServer(server).serverStats(server);
      sample = normalizeStats(stats, sampledAt);
    } catch (error) {
      sample = unavailableSample(error instanceof Error ? error.message : "Container stats are unavailable", sampledAt);
    }
    if (this.closed || this.options.isServerActive?.(server.id) === false) return sample;
    sample = this.options.decorateSample?.(server, sample) ?? sample;
    this.options.statsRepository.append(server.id, sample, sample.sampledAt - this.options.historyWindowMs);
    return sample;
  }
}
