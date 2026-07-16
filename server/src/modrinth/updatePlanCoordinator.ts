import type { ManagedServer } from "../types.js";
import type { ModUpdatePlan } from "./updatePlan.js";

type BuildModUpdatePlan = (server: ManagedServer, options: { forceRefresh: boolean }) => Promise<ModUpdatePlan>;

type ModUpdatePlanCache = {
  get: (serverId: string) => ModUpdatePlan | null;
  set: (plan: ModUpdatePlan) => void;
};

export class ModUpdatePlanCoordinator {
  private readonly plans = new Map<string, ModUpdatePlan>();
  private readonly inFlight = new Map<string, Promise<ModUpdatePlan>>();
  private interval: NodeJS.Timeout | undefined;

  constructor(private readonly options: {
    intervalMs: number;
    readServers: () => Promise<ManagedServer[]>;
    buildPlan: BuildModUpdatePlan;
    cache?: ModUpdatePlanCache;
    onError?: (error: unknown, server?: ManagedServer) => void;
  }) {}

  start() {
    if (this.interval) return;
    void this.refreshAll();
    this.interval = setInterval(() => void this.refreshAll(), this.options.intervalMs);
    this.interval.unref?.();
  }

  stop() {
    if (!this.interval) return;
    clearInterval(this.interval);
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
    const request = this.options.buildPlan(server, { forceRefresh: true })
      .then((plan) => {
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

  async refreshAll() {
    let servers: ManagedServer[];
    try {
      servers = await this.options.readServers();
    } catch (error) {
      this.options.onError?.(error);
      return;
    }
    for (const server of servers) {
      try {
        await this.refresh(server);
      } catch (error) {
        this.options.onError?.(error, server);
      }
    }
  }
}
