import type { ManagedServer } from "../types.js";
import type { ModUpdatePlan } from "./updatePlan.js";

type BuildModUpdatePlan = (server: ManagedServer, options: { forceRefresh: boolean }) => Promise<ModUpdatePlan>;

export class ModUpdatePlanCoordinator {
  private readonly plans = new Map<string, ModUpdatePlan>();
  private readonly inFlight = new Map<string, Promise<ModUpdatePlan>>();
  private interval: NodeJS.Timeout | undefined;

  constructor(private readonly options: {
    intervalMs: number;
    readServers: () => Promise<ManagedServer[]>;
    buildPlan: BuildModUpdatePlan;
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
    return this.plans.get(serverId) ?? null;
  }

  refresh(server: ManagedServer) {
    const pending = this.inFlight.get(server.id);
    if (pending) return pending;
    const request = this.options.buildPlan(server, { forceRefresh: true })
      .then((plan) => {
        this.plans.set(server.id, plan);
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
