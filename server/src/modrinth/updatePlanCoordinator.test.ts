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
  it("performs one upstream check when manual callers arrive during an inventory warm-up", async () => {
    let finish!: (plan: ReturnType<typeof createModUpdatePlan>) => void;
    const buildPlan = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValue(createModUpdatePlan(server.id, []));
    const coordinator = new ModUpdatePlanCoordinator({ intervalMs: 60_000, readServers: async () => [], buildPlan });
    const inventory = coordinator.refresh(server, false);
    const manual = coordinator.refresh(server);
    const joined = coordinator.refresh(server);
    expect(buildPlan).toHaveBeenCalledTimes(1);
    finish(createModUpdatePlan(server.id, []));
    await Promise.all([inventory, manual, joined]);
    expect(buildPlan).toHaveBeenCalledTimes(2);
    expect(buildPlan.mock.calls.map(([, options]) => options.forceRefresh)).toEqual([false, true]);
    coordinator.stop();
  });

  it("publishes inventory and plan together and prevents a pre-mutation scan from replacing them", async () => {
    let finishOld!: (scan: ReturnType<typeof createModUpdatePlan>) => void;
    const old = createModUpdatePlan(server.id, [updateSource("old.jar")]);
    const snapshot = { mods: [{ filename: "new.jar", enabled: true }], scannedAt: "2026-10-02T12:00:00Z" };
    const fresh = { ...createModUpdatePlan(server.id, [updateSource("new.jar")]), installedMods: snapshot };
    const cache = { get: () => null, getInstalled: () => null, set: vi.fn() };
    const buildPlan = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; })).mockResolvedValue(fresh);
    const coordinator = new ModUpdatePlanCoordinator({ intervalMs: 60_000, readServers: async () => [], buildPlan, cache });
    const pending = coordinator.refresh(server);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    coordinator.invalidate(server.id);
    await coordinator.refresh(server, false);
    finishOld(old);
    await rejected;
    expect(coordinator.getInstalled(server.id)).toBe(snapshot);
    expect(coordinator.get(server.id)?.updates[0].filename).toBe("new.jar");
    expect(coordinator.get(server.id)).not.toHaveProperty("installedMods");
    expect(cache.set).toHaveBeenCalledTimes(1);
    expect(cache.set.mock.calls[0][1]).toBe(snapshot);
    coordinator.stop();
  });

  it("warms every missing inventory at startup without triggering upstream checks for fresh plans", async () => {
    const servers = [server, { id: "server-b" } as ManagedServer, { id: "server-c" } as ManagedServer];
    const previous = new Map(servers.map(server => [server.id, createModUpdatePlan(server.id, [], new Date().toISOString())]));
    const snapshots = new Map<string, { mods: Array<Record<string, unknown>>; scannedAt: string }>();
    const buildPlan = vi.fn(async (current: ManagedServer, _options: { forceRefresh: boolean }) => ({ ...createModUpdatePlan(current.id, []),
      installedMods: { mods: [], scannedAt: new Date().toISOString() } }));
    const coordinator = new ModUpdatePlanCoordinator({ intervalMs: 60_000, readServers: async () => servers, buildPlan,
      cache: { get: id => previous.get(id) ?? null, getInstalled: id => snapshots.get(id) ?? null,
        set: (_plan, snapshot) => { if (snapshot) snapshots.set(_plan.serverId, snapshot); } } });
    coordinator.start();
    await vi.waitFor(() => expect(snapshots.size).toBe(3));
    expect(buildPlan).toHaveBeenCalledTimes(3);
    expect(buildPlan.mock.calls.every(([, options]) => options.forceRefresh === false)).toBe(true);
    for (const current of servers) expect(coordinator.get(current.id)?.generatedAt).toBe(previous.get(current.id)?.generatedAt);
    coordinator.stop();
  });

  it("retains the successful inventory when an upstream scan regresses known update metadata", async () => {
    const snapshot = { mods: [{ filename: "known.jar", enabled: true }], scannedAt: "2026-10-02T12:00:00Z" };
    const previous = createModUpdatePlan(server.id, [updateSource("known.jar")]);
    const cache = { get: () => previous, getInstalled: () => snapshot, set: vi.fn() };
    const coordinator = new ModUpdatePlanCoordinator({ intervalMs: 60_000, readServers: async () => [], cache,
      buildPlan: async () => ({ ...createModUpdatePlan(server.id, [updateSource("known.jar", false)]), installedMods: { mods: [], scannedAt: "2026-10-02T13:00:00Z" } }) });
    await expect(coordinator.refresh(server)).rejects.toThrow("Could not resolve update metadata");
    expect(coordinator.getInstalled(server.id)).toBe(snapshot);
    expect(cache.set).not.toHaveBeenCalled();
    coordinator.stop();
  });

  it("discards old-generation cache writes and progress after disable/re-enable", async () => {
    let finishOld!: (plan: ReturnType<typeof createModUpdatePlan>) => void;
    let oldProgress!: (progress: { checked: number; total: number }) => void;
    const fresh = createModUpdatePlan(server.id, []);
    const buildPlan = vi.fn().mockImplementationOnce((_server, options) => {
      oldProgress = options.onProgress;
      return new Promise(resolve => { finishOld = resolve; });
    }).mockResolvedValue(fresh);
    const cache = { get: () => null, set: vi.fn() };
    const coordinator = new ModUpdatePlanCoordinator({ intervalMs: 60_000, readServers: async () => [], buildPlan, cache });
    const old = coordinator.refresh(server);
    const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
    coordinator.stop();
    coordinator.start();
    await coordinator.refresh(server);
    oldProgress({ checked: 20, total: 30 });
    expect(coordinator.getProgress(server.id).active).toBe(false);
    finishOld(createModUpdatePlan(server.id, [], "2000-01-01T00:00:00Z"));
    await rejected;
    expect(cache.set).toHaveBeenCalledExactlyOnceWith(fresh);
    expect(coordinator.get(server.id)).toBe(fresh);
    coordinator.stop();
  });

  it("keeps healthy servers moving when the oldest server never completes a scan", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-02T12:00:00Z");
    const healthy = { id: "healthy" } as ManagedServer;
    const previous = createModUpdatePlan(healthy.id, [], "2026-10-02T11:59:30Z");
    const buildPlan = vi.fn(async (current: ManagedServer) => {
      if (current.id === server.id) throw new Error("offline");
      return createModUpdatePlan(current.id, []);
    });
    const coordinator = new ModUpdatePlanCoordinator({ intervalMs: 60_000, readServers: async () => [server, healthy],
      buildPlan, cache: { get: id => id === healthy.id ? previous : null, set: vi.fn() } });
    coordinator.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.get(healthy.id)).toBe(previous);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(buildPlan.mock.calls.filter(([current]) => current.id === healthy.id)).toHaveLength(4);
    expect(buildPlan.mock.calls.filter(([current]) => current.id === server.id)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(buildPlan.mock.calls.filter(([current]) => current.id === server.id)).toHaveLength(2);
    coordinator.stop();
  });

  it("backs failures off independently of the retained successful plan and resets after recovery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-10-02T12:00:00Z");
    const previous = createModUpdatePlan(server.id, [], "2026-10-01T12:00:00Z");
    let failing = true;
    const buildPlan = vi.fn(async () => {
      if (failing) throw new Error("offline");
      return createModUpdatePlan(server.id, []);
    });
    const cache = { get: () => previous, set: vi.fn() };
    const coordinator = new ModUpdatePlanCoordinator({ intervalMs: 60_000, readServers: async () => [server], buildPlan, cache });
    coordinator.start();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(buildPlan).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(buildPlan).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    expect(buildPlan).toHaveBeenCalledTimes(4);
    expect(coordinator.get(server.id)).toBe(previous);
    expect(cache.set).not.toHaveBeenCalled();
    failing = false;
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(buildPlan).toHaveBeenCalledTimes(5);
    expect(coordinator.get(server.id)).not.toBe(previous);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(buildPlan).toHaveBeenCalledTimes(6);
    coordinator.stop();
  });

  it("rolls five servers across the configured interval instead of checking them all at once", async () => {
    vi.useFakeTimers();
    const servers = Array.from({ length: 5 }, (_, index) => ({ id: `server-${index}` } as ManagedServer));
    const buildPlan = vi.fn(async (current: ManagedServer) => createModUpdatePlan(current.id, []));
    const coordinator = new ModUpdatePlanCoordinator({ intervalMs: 3_600_000, readServers: async () => servers, buildPlan });
    coordinator.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(buildPlan).toHaveBeenCalledTimes(1);
    for (let index = 1; index < 5; index += 1) {
      await vi.advanceTimersByTimeAsync(720_000);
      expect(buildPlan).toHaveBeenCalledTimes(index + 1);
      expect(buildPlan.mock.calls[index][0].id).toBe(`server-${index}`);
    }
    await vi.advanceTimersByTimeAsync(720_000);
    expect(buildPlan.mock.calls[5][0].id).toBe("server-0");
    coordinator.stop();
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(buildPlan).toHaveBeenCalledTimes(6);
  });

  it("does not overlap slow scans or restart the timer after stopping mid-scan", async () => {
    vi.useFakeTimers();
    let finish!: (plan: ReturnType<typeof createModUpdatePlan>) => void;
    const buildPlan = vi.fn(() => new Promise<ReturnType<typeof createModUpdatePlan>>((resolve) => { finish = resolve; }));
    const coordinator = new ModUpdatePlanCoordinator({ intervalMs: 60_000, readServers: async () => [server], buildPlan });
    coordinator.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(buildPlan).toHaveBeenCalledTimes(1);
    coordinator.stop();
    finish(createModUpdatePlan(server.id, []));
    await vi.advanceTimersByTimeAsync(120_000);
    expect(buildPlan).toHaveBeenCalledTimes(1);
  });

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

  it("serves a persisted plan and waits until it is due before refreshing after startup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-09-20T12:00:00.000Z");
    const previous = createModUpdatePlan(server.id, [], "2026-09-20T01:00:00.000Z");
    const buildPlan = vi.fn(async () => createModUpdatePlan(server.id, []));
    const coordinator = new ModUpdatePlanCoordinator({
      intervalMs: 12 * 60 * 60 * 1000,
      readServers: async () => [server],
      buildPlan,
      cache: { get: () => previous, set: vi.fn() }
    });

    coordinator.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(coordinator.get(server.id)).toBe(previous);
    expect(buildPlan).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(59 * 60 * 1000);
    expect(buildPlan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(buildPlan).toHaveBeenCalledTimes(1);
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

  it("publishes per-mod progress while a refresh is running", async () => {
    let finish!: () => void;
    const buildPlan = vi.fn(async (_server: ManagedServer, options: { onProgress: (progress: { checked: number; total: number }) => void }) => {
      options.onProgress({ checked: 12, total: 28 });
      await new Promise<void>((resolve) => { finish = resolve; });
      return createModUpdatePlan(server.id, []);
    });
    const coordinator = new ModUpdatePlanCoordinator({ intervalMs: 60_000, readServers: async () => [server], buildPlan });

    const refresh = coordinator.refresh(server);
    await vi.waitFor(() => expect(coordinator.getProgress(server.id)).toEqual({ active: true, checked: 12, total: 28 }));
    finish();
    await refresh;

    expect(coordinator.getProgress(server.id)).toEqual({ active: false, checked: 0, total: 0 });
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
