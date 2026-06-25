import type { ManagedServer } from "./types.js";
import type { NodeRuntime } from "./nodes/types.js";
import type { ResourceStatsRepository } from "./storage/resourceStatsRepository.js";

export type ResourceStatsSample = {
  available: boolean;
  running: boolean;
  cpuPercent: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  networkRxBytes?: number;
  networkTxBytes?: number;
  readAt: string;
  container?: string;
  message?: string;
  sampledAt: number;
};

export type ResourceStatsHistory = {
  samples: ResourceStatsSample[];
};

type CollectorOptions = {
  pollMs: number;
  historyWindowMs: number;
  readServers: () => Promise<ManagedServer[]>;
  runtimeForServer: (server: ManagedServer) => NodeRuntime;
  statsRepository: ResourceStatsRepository;
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
  private readonly samples = new Map<string, ResourceStatsSample[]>();
  private readonly inFlight = new Map<string, Promise<ResourceStatsSample>>();
  private interval: NodeJS.Timeout | undefined;

  constructor(private readonly options: CollectorOptions) {}

  start() {
    if (this.interval) return;
    void this.loadAll().then(() => this.collectAll()).catch(() => undefined);
    this.interval = setInterval(() => void this.collectAll().catch(() => undefined), this.options.pollMs);
    this.interval.unref?.();
  }

  stop() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = undefined;

  }

  async collectAll() {
    const servers = await this.options.readServers();
    const serverIds = new Set(servers.map((server) => server.id));
    for (const serverId of this.samples.keys()) {
      if (!serverIds.has(serverId)) {
        this.samples.delete(serverId);
      }
    }
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

  async history(server: ManagedServer): Promise<ResourceStatsHistory> {
    if (!this.samples.get(server.id)?.length) {
      await this.collectServer(server);
    }
    return { samples: [...(this.samples.get(server.id) ?? [])] };
  }

  latest(server: ManagedServer) {
    return this.samples.get(server.id)?.at(-1);
  }

  private async collectServerOnce(server: ManagedServer) {
    const sampledAt = Date.now();
    try {
      const stats = await this.options.runtimeForServer(server).serverStats(server);
      return this.append(server.id, normalizeStats(stats, sampledAt));
    } catch (error) {
      return this.append(server.id, unavailableSample((error as Error).message || "Container stats are unavailable", sampledAt));
    }
  }

  private append(serverId: string, sample: ResourceStatsSample) {
    const cutoff = sample.sampledAt - this.options.historyWindowMs;
    const existing = this.samples.get(serverId) ?? [];
    const next = [...existing, sample].filter((item) => item.sampledAt >= cutoff);
    this.samples.set(serverId, next);
    this.options.statsRepository.append(serverId, sample, cutoff);
    return sample;
  }

  private async loadAll() {
    try {
      const servers = await this.options.readServers();
      const cutoff = Date.now() - this.options.historyWindowMs;
      for (const server of servers) {
        const samples = this.options.statsRepository.list(server.id, cutoff);
        if (samples.length > 0) this.samples.set(server.id, samples);
      }
    } catch {
      // Ignore error reading servers
    }
  }
}
