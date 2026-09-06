import type { ManagedServer } from "../types.js";
import type { ModUpdatePlan } from "./updatePlan.js";

type BuildModUpdatePlan = (server: ManagedServer, options: { forceRefresh: boolean }) => Promise<ModUpdatePlan>;

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

  refresh(server: ManagedServer) {
    const pending = this.inFlight.get(server.id);
    if (pending) return pending;
    const previous = this.get(server.id);
    const request = this.options.buildPlan(server, { forceRefresh: true })
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
        delayMs = Math.max(1, Math.floor(this.options.intervalMs / servers.length));
        const server = servers[this.nextServerIndex % servers.length];
        this.nextServerIndex = (this.nextServerIndex + 1) % servers.length;
        try {
          await this.refresh(server);
        } catch (error) {
          this.options.onError?.(error, server);
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
