import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedServer } from "../types.js";
import { createModUpdatePlan } from "./updatePlan.js";
import { ModUpdatePlanCoordinator } from "./updatePlanCoordinator.js";

const server = { id: "server-a" } as ManagedServer;

afterEach(() => {
  vi.useRealTimers();
});

describe("ModUpdatePlanCoordinator", () => {
  it("refreshes immediately and periodically without a page request", async () => {
    vi.useFakeTimers();
    const buildPlan = vi.fn(async () => createModUpdatePlan(server.id, []));
    const coordinator = new ModUpdatePlanCoordinator({
      intervalMs: 60_000,
      readServers: async () => [server],
      buildPlan
    });

    coordinator.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(buildPlan).toHaveBeenCalledTimes(1);
    expect(coordinator.get(server.id)?.serverId).toBe(server.id);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(buildPlan).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it("keeps the last successful plan when a later refresh fails", async () => {
    const plan = createModUpdatePlan(server.id, []);
    const buildPlan = vi.fn()
      .mockResolvedValueOnce(plan)
      .mockRejectedValueOnce(new Error("Modrinth unavailable"));
    const coordinator = new ModUpdatePlanCoordinator({
      intervalMs: 60_000,
      readServers: async () => [server],
      buildPlan
    });

    await coordinator.refresh(server);
    await expect(coordinator.refresh(server)).rejects.toThrow("Modrinth unavailable");
    expect(coordinator.get(server.id)).toBe(plan);
  });

  it("restores and replaces the last successful plan through a durable cache", async () => {
    const plans = new Map<string, ReturnType<typeof createModUpdatePlan>>();
    const cache = {
      get: vi.fn((serverId: string) => plans.get(serverId) ?? null),
      set: vi.fn((plan: ReturnType<typeof createModUpdatePlan>) => plans.set(plan.serverId, plan))
    };
    const previous = createModUpdatePlan(server.id, [], "2026-01-01T00:00:00.000Z");
    plans.set(server.id, previous);
    const refreshed = createModUpdatePlan(server.id, [], "2026-01-01T01:00:00.000Z");
    const coordinator = new ModUpdatePlanCoordinator({
      intervalMs: 60_000,
      readServers: async () => [server],
      buildPlan: vi.fn(async () => refreshed),
      cache
    });

    expect(coordinator.get(server.id)).toBe(previous);
    await coordinator.refresh(server);
    expect(cache.set).toHaveBeenCalledWith(refreshed);
    expect(coordinator.get(server.id)).toBe(refreshed);
  });
});
