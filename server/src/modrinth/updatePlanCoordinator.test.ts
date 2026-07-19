import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedServer } from "../types.js";
import { createModUpdatePlan } from "./updatePlan.js";
import { ModUpdatePlanCoordinator } from "./updatePlanCoordinator.js";

const server = { id: "server-a" } as ManagedServer;

function updateSource(filename: string, resolved = true) {
  return {
    filename,
    displayName: filename,
    enabled: true,
    preferredChannel: "release",
    compatibility: { status: "compatible", compatible: true, serverSide: "required" },
    modrinth: { projectId: `project-${filename}`, versionNumber: "1.0.0" },
    versionInfo: resolved ? {
      currentVersion: "1.0.0",
      latestVersion: "2.0.0",
      latestFilename: filename,
      upToDate: false
    } : undefined
  };
}

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

  it("keeps the last complete plan when a later scan only resolves some known mods", async () => {
    const previous = createModUpdatePlan(server.id, [
      updateSource("one.jar"),
      updateSource("two.jar"),
      updateSource("three.jar")
    ]);
    const incomplete = createModUpdatePlan(server.id, [
      updateSource("one.jar"),
      updateSource("two.jar", false),
      updateSource("three.jar", false)
    ]);
    const cache = {
      get: vi.fn(() => previous),
      set: vi.fn()
    };
    const coordinator = new ModUpdatePlanCoordinator({
      intervalMs: 60_000,
      readServers: async () => [server],
      buildPlan: vi.fn(async () => incomplete),
      cache
    });

    await expect(coordinator.refresh(server)).rejects.toThrow("Could not resolve update metadata for 2 known mods");
    expect(cache.set).not.toHaveBeenCalled();
    expect(coordinator.get(server.id)).toBe(previous);
    expect(coordinator.get(server.id)?.counts.safeUpdates).toBe(3);
  });

  it("still caches complete plans containing unrecognized local mods", async () => {
    const complete = createModUpdatePlan(server.id, [
      updateSource("known.jar"),
      { filename: "manual.jar", displayName: "Manual mod", enabled: true }
    ]);
    const cache = { get: vi.fn(() => null), set: vi.fn() };
    const coordinator = new ModUpdatePlanCoordinator({
      intervalMs: 60_000,
      readServers: async () => [server],
      buildPlan: vi.fn(async () => complete),
      cache
    });

    await expect(coordinator.refresh(server)).resolves.toBe(complete);
    expect(cache.set).toHaveBeenCalledWith(complete);
    expect(coordinator.get(server.id)?.counts.unknown).toBe(1);
  });

  it("caches a first scan when a known mod has no prior resolved result", async () => {
    const initial = createModUpdatePlan(server.id, [updateSource("known.jar", false)]);
    const cache = { get: vi.fn(() => null), set: vi.fn() };
    const coordinator = new ModUpdatePlanCoordinator({
      intervalMs: 60_000,
      readServers: async () => [server],
      buildPlan: vi.fn(async () => initial),
      cache
    });

    await expect(coordinator.refresh(server)).resolves.toBe(initial);
    expect(cache.set).toHaveBeenCalledWith(initial);
    expect(coordinator.get(server.id)?.counts.unknown).toBe(1);
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
