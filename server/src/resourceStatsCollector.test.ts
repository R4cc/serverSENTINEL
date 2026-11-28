import { afterEach, expect, it, vi } from "vitest";
import { ResourceStatsCollector } from "./resourceStatsCollector.js";
import { ResourceStatsRepository } from "./storage/resourceStatsRepository.js";
import { openStorageDatabase } from "./storage/database.js";
import type { NodeRuntime } from "./nodes/types.js";
import type { ManagedServer } from "./types.js";

afterEach(() => vi.useRealTimers());

it.each(["stop", "delete"])("discards pending stats after %s", async (action) => {
  const server = { id: "a" } as ManagedServer;
  let release!: (value: unknown) => void;
  const pending = new Promise((resolve) => { release = resolve; });
  const append = vi.fn();
  let active = true;
  const collector = new ResourceStatsCollector({
    pollMs: 5_000, historyWindowMs: 60_000, readServers: async () => [server],
    isServerActive: () => active,
    runtimeForServer: () => ({ serverStats: () => pending }) as unknown as NodeRuntime,
    statsRepository: { append } as unknown as ResourceStatsRepository
  });
  const collection = collector.collectServer(server);
  if (action === "stop") collector.stop();
  else active = false;
  release({ available: true, running: true });
  await collection;
  expect(append).not.toHaveBeenCalled();
});

it("does not retry a failed repository write as an unavailable sample", async () => {
  const append = vi.fn(() => { throw new Error("database closed"); });
  const collector = new ResourceStatsCollector({
    pollMs: 5_000, historyWindowMs: 60_000, readServers: async () => [],
    runtimeForServer: () => ({ serverStats: async () => ({ available: true }) }) as unknown as NodeRuntime,
    statsRepository: { append } as unknown as ResourceStatsRepository
  });
  await expect(collector.collectServer({ id: "a" } as ManagedServer)).rejects.toThrow("database closed");
  expect(append).toHaveBeenCalledTimes(1);
});

it("reads persisted history relative to its newest sample without polling the runtime", async () => {
  vi.useFakeTimers();
  const now = 20_000_000;
  const latest = now - 30_000;
  vi.setSystemTime(now);
  const server = { id: "a" } as ManagedServer;
  const storage = openStorageDatabase(":memory:");
  try {
    storage.connection.exec(`
      INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at) VALUES ('local', 'Local', 'local', 'online', 1, '', '');
      INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, created_at, updated_at)
        VALUES ('a', 'local', 'A', '/a', '{}', '', ''), ('b', 'local', 'B', '/b', '{}', '', '');
    `);
    const repository = new ResourceStatsRepository(storage);
    for (const sampledAt of [latest - 3_600_001, latest - 3_600_000, latest]) {
      repository.append("a", { sampledAt, readAt: new Date(sampledAt).toISOString(), available: true,
        running: true, cpuPercent: 0, memoryUsageBytes: 0, memoryLimitBytes: 0 }, 0);
    }
    const serverStats = vi.fn(async () => ({ available: true, running: true }));
    const collector = new ResourceStatsCollector({
      pollMs: 5_000, historyWindowMs: 7 * 86_400_000, readServers: async () => [server],
      runtimeForServer: () => ({ serverStats }) as unknown as NodeRuntime,
      statsRepository: repository
    });
    expect((await collector.history(server)).samples.map(({ sampledAt }) => sampledAt))
      .toEqual([latest - 3_600_000, latest]);
    expect((await collector.history(server, 7 * 86_400_000)).samples).toHaveLength(3);
    expect(serverStats).not.toHaveBeenCalled();

    const emptyServer = { id: "b" } as ManagedServer;
    const [first, second] = await Promise.all([collector.history(emptyServer), collector.history(emptyServer)]);
    expect(first.samples.map(({ sampledAt }) => sampledAt)).toEqual([now]);
    expect(second).toEqual(first);
    expect(serverStats).toHaveBeenCalledTimes(1);
  } finally {
    storage.close();
  }
});

it("prunes persisted samples at startup and starts one live collection", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(20_000_000);
  const readServers = vi.fn(async () => [{ id: "a" } as ManagedServer]);
  const prune = vi.fn();
  const append = vi.fn();
  const collector = new ResourceStatsCollector({
    pollMs: 5_000, historyWindowMs: 7 * 86_400_000, readServers,
    runtimeForServer: () => ({ serverStats: async () => ({}) }) as unknown as NodeRuntime,
    statsRepository: { prune, append } as unknown as ResourceStatsRepository
  });
  collector.start();
  await vi.advanceTimersByTimeAsync(0);
  collector.stop();
  expect(prune).toHaveBeenCalledWith(20_000_000 - 7 * 86_400_000);
  expect(readServers).toHaveBeenCalledTimes(1);
  expect(append).toHaveBeenCalledWith("a", expect.anything(), 20_000_000 - 7 * 86_400_000);
});
