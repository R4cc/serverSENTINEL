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
});
