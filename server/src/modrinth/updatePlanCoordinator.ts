import type { ManagedServer } from "../types.js";
import type { ModUpdatePlan } from "./updatePlan.js";

export type ModUpdateCheckProgress = {
  active: boolean;
  checked: number;
  total: number;
};

export type CachedInstalledMods = { mods: Array<Record<string, unknown>>; scannedAt: string };
export type ModUpdateScan = ModUpdatePlan & { installedMods?: CachedInstalledMods };

type BuildModUpdatePlan = (server: ManagedServer, options: {
  forceRefresh: boolean;
  onProgress: (progress: Omit<ModUpdateCheckProgress, "active">) => void;
  signal: AbortSignal;
}) => Promise<ModUpdateScan>;

type ModUpdatePlanCache = {
  get: (serverId: string) => ModUpdatePlan | null;
  getInstalled?: (serverId: string) => CachedInstalledMods | null;
  set: (plan: ModUpdatePlan, installedMods?: CachedInstalledMods) => void;
};

function regressedKnownUpdates(previous: ModUpdatePlan | null, next: ModUpdatePlan) {
  if (!previous) return [];
  const previousByProject = new Map(previous.updates.flatMap((entry) => entry.projectId ? [[entry.projectId, entry] as const] : []));
  const previousByFilename = new Map(previous.updates.map((entry) => [entry.filename, entry]));
  return next.updates.filter((entry) => {
    if (!entry.projectId || entry.status !== "unknown") return false;
    const prior = previousByProject.get(entry.projectId) ?? previousByFilename.get(entry.filename);
    return prior !== undefined && prior.status !== "unknown";
  });
}

export class ModUpdatePlanCoordinator {
  private readonly plans = new Map<string, ModUpdatePlan>();
  private readonly inFlight = new Map<string, Promise<ModUpdatePlan>>();
  private readonly progress = new Map<string, Omit<ModUpdateCheckProgress, "active">>();
  private interval: NodeJS.Timeout | undefined;
  private running = false;
  private generation = 0;
  private nextServerIndex = 0;
  private controller = new AbortController();
  private readonly retries = new Map<string, { failures: number; eligibleAt: number }>();
  private readonly installed = new Map<string, CachedInstalledMods>();
  private readonly scans = new Map<string, AbortController>();
  private readonly scanModes = new Map<string, boolean>();
  private readonly primed = new Set<string>();

  constructor(private readonly options: {
    intervalMs: number;
    readServers: () => Promise<ManagedServer[]>;
    buildPlan: BuildModUpdatePlan;
    cache?: ModUpdatePlanCache;
    onError?: (error: unknown, server?: ManagedServer) => void;
  }) {}

  start() {
    if (this.running) return;
    if (this.controller.signal.aborted) this.controller = new AbortController();
    this.running = true;
    void this.refreshNext(++this.generation);
  }

  stop() {
    this.running = false;
    this.generation += 1;
    this.controller.abort();
    this.inFlight.clear();
    this.progress.clear();
    this.scans.clear();
    this.scanModes.clear();
    clearTimeout(this.interval);
    this.interval = undefined;
  }

  get(serverId: string) {
    const current = this.plans.get(serverId);
    if (current) return current;
    try {
      const cached = this.options.cache?.get(serverId) ?? null;
      if (cached) this.plans.set(serverId, cached);
      return cached;
    } catch (error) {
      this.options.onError?.(error);
      return null;
    }
  }

  getProgress(serverId: string): ModUpdateCheckProgress {
    const progress = this.progress.get(serverId);
    return progress ? { active: true, ...progress } : { active: false, checked: 0, total: 0 };
  }

  getInstalled(serverId: string) {
    const cached = this.installed.get(serverId) ?? this.options.cache?.getInstalled?.(serverId) ?? null;
    if (cached) this.installed.set(serverId, cached);
    return cached;
  }

  invalidate(serverId: string) {
    this.scans.get(serverId)?.abort();
    this.inFlight.delete(serverId);
    this.progress.delete(serverId);
  }

  refresh(server: ManagedServer, forceRefresh = true): Promise<ModUpdatePlan> {
    const pending = this.inFlight.get(server.id);
    if (pending) {
      // A quick inventory warm-up cannot satisfy an explicit upstream check.
      if (forceRefresh && !this.scanModes.get(server.id)) {
        return pending.then(() => this.refresh(server), () => this.refresh(server));
      }
      return pending;
    }
    const previous = this.get(server.id);
    const controller = new AbortController();
    this.scans.set(server.id, controller);
    this.scanModes.set(server.id, forceRefresh);
    const signal = AbortSignal.any([this.controller.signal, controller.signal]);
    signal.throwIfAborted();
    this.progress.set(server.id, { checked: 0, total: previous?.counts.totalInstalled ?? 0 });
    const request = this.options.buildPlan(server, {
      forceRefresh,
      signal,
      onProgress: (progress) => { if (!signal.aborted) this.progress.set(server.id, progress); }
    })
      .then((scan) => {
        signal.throwIfAborted();
        const plan = scan.installedMods ? (({ installedMods: _installed, ...value }) => value)(scan) : scan;
        if (!forceRefresh) plan.generatedAt = previous?.generatedAt ?? new Date(0).toISOString();
        const unresolved = forceRefresh ? regressedKnownUpdates(previous, plan) : [];
        if (unresolved.length) {
          throw new Error(`Could not resolve update metadata for ${unresolved.length} known ${unresolved.length === 1 ? "mod" : "mods"}`);
        }
        this.plans.set(server.id, plan);
        if (scan.installedMods) this.installed.set(server.id, scan.installedMods);
        if (forceRefresh) this.retries.delete(server.id);
        try {
          if (scan.installedMods) this.options.cache?.set(plan, scan.installedMods);
          else this.options.cache?.set(plan);
        } catch (error) {
          this.options.onError?.(error, server);
        }
        return plan;
      })
      .finally(() => {
        if (this.inFlight.get(server.id) === request) {
          this.inFlight.delete(server.id);
          this.progress.delete(server.id);
          if (this.scans.get(server.id) === controller) this.scans.delete(server.id);
          this.scanModes.delete(server.id);
        }
      });
    this.inFlight.set(server.id, request);
    return request;
  }

  private async refreshNext(generation: number) {
    let delayMs = this.options.intervalMs;
    try {
      const servers = await this.options.readServers();
      if (!this.running || generation !== this.generation) return;
      // Warm missing inventories without a Modrinth burst, independently of the staggered checks.
      // Persisted snapshots make subsequent boots and all browser visits simple cache reads.
      if (this.options.cache?.getInstalled) {
        for (const server of servers) {
          if (this.getInstalled(server.id) || this.primed.has(server.id)) continue;
          this.primed.add(server.id);
          try { await this.refresh(server, false); } catch (error) { this.options.onError?.(error, server); }
          if (!this.running || generation !== this.generation) return;
        }
      }
      if (servers.length) {
        const now = Date.now();
        const orderedServers = Array.from(
          { length: servers.length },
          (_, offset) => servers[(this.nextServerIndex + offset) % servers.length]
        );
        const candidates = orderedServers
          .map((server) => {
            const generatedAt = Date.parse(this.get(server.id)?.generatedAt ?? "");
            const lastGeneratedAt = Number.isFinite(generatedAt) ? Math.min(generatedAt, now) : 0;
            const dueAt = lastGeneratedAt && (!this.options.cache?.getInstalled || this.getInstalled(server.id))
              ? lastGeneratedAt + this.options.intervalMs : 0;
            return { server, dueAt: Math.max(dueAt, this.retries.get(server.id)?.eligibleAt ?? 0) };
          });
        // Fairness is independent of the last successful timestamp: an offline server must not
        // remain the oldest candidate forever and prevent healthy servers from being checked.
        const next = candidates.find((candidate) => candidate.dueAt <= now)
          ?? candidates.reduce((earliest, candidate) => candidate.dueAt < earliest.dueAt ? candidate : earliest);

        if (next.dueAt <= now) {
          this.nextServerIndex = (servers.indexOf(next.server) + 1) % servers.length;
          // A full pass still spans the configured interval, avoiding a startup burst when several
          // servers have no plan yet. Fresh persisted plans stay available and are not rechecked.
          delayMs = Math.max(1, Math.floor(this.options.intervalMs / servers.length));
          try {
            await this.refresh(next.server);
            this.retries.delete(next.server.id);
          } catch (error) {
            if (!this.running || generation !== this.generation) return;
            if (error instanceof Error && error.name === "AbortError") return;
            const failures = (this.retries.get(next.server.id)?.failures ?? 0) + 1;
            const retryDelayMs = Math.min(5 * 60_000 * 2 ** Math.min(failures - 1, 3), 30 * 60_000);
            this.retries.set(next.server.id, { failures, eligibleAt: Date.now() + retryDelayMs });
            this.options.onError?.(error, next.server);
          }
        } else {
          delayMs = Math.max(1, next.dueAt - now);
        }
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      if (this.running && generation === this.generation) {
        // Spread servers across the interval and never overlap background scans.
        this.interval = setTimeout(() => void this.refreshNext(generation), delayMs);
        this.interval.unref?.();
      }
    }
  }
}
