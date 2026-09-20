import type { ManagedServer } from "../types.js";
import type { ModUpdatePlan } from "./updatePlan.js";

export type ModUpdateCheckProgress = {
  active: boolean;
  checked: number;
  total: number;
};

type BuildModUpdatePlan = (server: ManagedServer, options: {
  forceRefresh: boolean;
  onProgress: (progress: Omit<ModUpdateCheckProgress, "active">) => void;
}) => Promise<ModUpdatePlan>;

type ModUpdatePlanCache = {
  get: (serverId: string) => ModUpdatePlan | null;
  set: (plan: ModUpdatePlan) => void;
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

  constructor(private readonly options: {
    intervalMs: number;
    readServers: () => Promise<ManagedServer[]>;
    buildPlan: BuildModUpdatePlan;
    cache?: ModUpdatePlanCache;
    onError?: (error: unknown, server?: ManagedServer) => void;
  }) {}

  start() {
    if (this.running) return;
    this.running = true;
    void this.refreshNext(++this.generation);
  }

  stop() {
    this.running = false;
    this.generation += 1;
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

  refresh(server: ManagedServer) {
    const pending = this.inFlight.get(server.id);
    if (pending) return pending;
    const previous = this.get(server.id);
    this.progress.set(server.id, { checked: 0, total: previous?.counts.totalInstalled ?? 0 });
    const request = this.options.buildPlan(server, {
      forceRefresh: true,
      onProgress: (progress) => this.progress.set(server.id, progress)
    })
      .then((plan) => {
        const unresolved = regressedKnownUpdates(previous, plan);
        if (unresolved.length) {
          throw new Error(`Could not resolve update metadata for ${unresolved.length} known ${unresolved.length === 1 ? "mod" : "mods"}`);
        }
        this.plans.set(server.id, plan);
        try {
          this.options.cache?.set(plan);
        } catch (error) {
          this.options.onError?.(error, server);
        }
        return plan;
      })
      .finally(() => {
        this.inFlight.delete(server.id);
        this.progress.delete(server.id);
      });
    this.inFlight.set(server.id, request);
    return request;
  }

  private async refreshNext(generation: number) {
    let delayMs = this.options.intervalMs;
    try {
      const servers = await this.options.readServers();
      if (!this.running || generation !== this.generation) return;
      if (servers.length) {
        const now = Date.now();
        const orderedServers = Array.from(
          { length: servers.length },
          (_, offset) => servers[(this.nextServerIndex + offset) % servers.length]
        );
        const next = orderedServers
          .map((server) => {
            const generatedAt = Date.parse(this.get(server.id)?.generatedAt ?? "");
            const lastGeneratedAt = Number.isFinite(generatedAt) ? Math.min(generatedAt, now) : 0;
            return { server, dueAt: lastGeneratedAt ? lastGeneratedAt + this.options.intervalMs : 0 };
          })
          .reduce((earliest, candidate) => candidate.dueAt < earliest.dueAt ? candidate : earliest);

        if (next.dueAt <= now) {
          this.nextServerIndex = (servers.indexOf(next.server) + 1) % servers.length;
          // A full pass still spans the configured interval, avoiding a startup burst when several
          // servers have no plan yet. Fresh persisted plans stay available and are not rechecked.
          delayMs = Math.max(1, Math.floor(this.options.intervalMs / servers.length));
          try {
            await this.refresh(next.server);
          } catch (error) {
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
