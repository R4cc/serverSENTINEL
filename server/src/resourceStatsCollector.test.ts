import { afterEach, expect, it, vi } from "vitest";
import { ResourceStatsCollector } from "./resourceStatsCollector.js";
import type { ResourceStatsRepository } from "./storage/resourceStatsRepository.js";
import type { NodeRuntime } from "./nodes/types.js";
import type { ManagedServer } from "./types.js";

afterEach(() => vi.useRealTimers());

it("bounds live history by age and count while retaining the full database window", async () => {
  vi.useFakeTimers();
  const server = { id: "a" } as ManagedServer;
  const append = vi.fn();
  const list = vi.fn(() => []);
  const collector = new ResourceStatsCollector({
    pollMs: 5_000, historyWindowMs: 7 * 86_400_000, readServers: async () => [server],
    runtimeForServer: () => ({ serverStats: async () => ({ available: true, running: true }) }) as unknown as NodeRuntime,
    statsRepository: { append, list } as unknown as ResourceStatsRepository
  });
  for (let index = 0; index < 2_005; index++) {
    vi.setSystemTime(10_000_000 + index);
    await collector.collectServer(server);
  }
  // A full memory buffer falls back to disk rather than silently truncating the API history.
  expect((collector as unknown as { samples: Map<string, unknown[]> }).samples.get("a")).toHaveLength(2_000);
  await collector.history(server);
  expect(list).toHaveBeenCalledWith("a", 10_002_004 - 3_600_000);
  vi.setSystemTime(20_000_000);
  await collector.collectServer(server);
  expect((await collector.history(server)).samples).toHaveLength(1);
  expect(append).toHaveBeenLastCalledWith("a", expect.anything(), 20_000_000 - 7 * 86_400_000);
  await collector.history(server, 7 * 86_400_000);
  expect(list).toHaveBeenLastCalledWith("a", 20_000_000 - 7 * 86_400_000);
});

it("loads only bounded recent history at startup", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(20_000_000);
  const recent = vi.fn(() => []);
  const collector = new ResourceStatsCollector({
    pollMs: 5_000, historyWindowMs: 7 * 86_400_000, readServers: async () => [{ id: "a" } as ManagedServer],
    runtimeForServer: () => ({ serverStats: async () => ({}) }) as unknown as NodeRuntime,
    statsRepository: { recent, prune: vi.fn(), append: vi.fn() } as unknown as ResourceStatsRepository
  });
  collector.start();
  await vi.advanceTimersByTimeAsync(0);
  collector.stop();
  expect(recent).toHaveBeenCalledWith("a", 20_000_000 - 3_600_000, 2_000);
});
