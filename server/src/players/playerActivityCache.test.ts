import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDatabase, type StorageDatabase } from "../storage/database.js";
import { ResourceStatsRepository } from "../storage/resourceStatsRepository.js";
import type { ResourceStatsSample } from "../resourceStatsCollector.js";
import { playerActivityHours } from "./playerInsights.js";
import { PlayerActivityCache } from "./playerActivityCache.js";

let storage: StorageDatabase | undefined;
afterEach(() => storage?.close());

function sample(sampledAt: number, playersOnline?: number): ResourceStatsSample {
  return { sampledAt, playersOnline, available: true, running: true, cpuPercent: 0, memoryUsageBytes: 0, memoryLimitBytes: 0, readAt: new Date(sampledAt).toISOString() };
}

describe("cached player activity", () => {
  it("matches raw history across slot boundaries, missing counts, server totals and time zones", () => {
    storage = openStorageDatabase(":memory:");
    storage.connection.prepare("INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at) VALUES ('local', 'Local', 'local', 'online', 1, '', '')").run();
    for (const id of ["a", "b"]) storage.connection.prepare("INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, created_at, updated_at) VALUES (?, 'local', ?, ?, '{}', '', '')").run(id, id, id);
    const repository = new ResourceStatsRepository(storage);
    const base = Date.parse("2026-04-04T14:59:00Z");
    const history = {
      a: [sample(base, 99), sample(base + 5_000, 4), sample(base + 9_000, 2), sample(base + 10_000), sample(base + 15_000, 0), sample(base + 65_000, 7)],
      b: [sample(base + 7_000, 6), sample(base + 15_000, 3)]
    };
    for (const [id, samples] of Object.entries(history)) for (const entry of samples) repository.append(id, entry, 0);
    const read = vi.spyOn(repository, "activitySamples");
    const cache = new PlayerActivityCache(repository);
    const now = base + 70_000;
    for (const zone of ["UTC", "Australia/Lord_Howe", "Asia/Kathmandu"]) {
      expect(cache.hours(["b", "a"], zone, 68_000, now)).toEqual(playerActivityHours({ resourceSamples: history, timeZone: zone, from: base + 2_000 }));
    }
    read.mockClear();
    const cached = cache.hours(["a", "b"], "UTC", 68_000, now + 59_999);
    expect(read).not.toHaveBeenCalled();
    repository.append("a", sample(now + 60_000, 12), 0);
    expect(cache.hours(["a", "b"], "UTC", 68_000, now + 60_000)).not.toEqual(cached);
    expect(read).toHaveBeenCalledTimes(2);
    expect(repository.recent("a", base + 5_000, 2).map((entry) => entry.sampledAt)).toEqual([base + 65_000, now + 60_000]);
    expect(repository.listRange("a", base + 15_000, base + 65_000)).toHaveLength(2);
  });

  it("bounds cached selections and refreshes on clock rollback or window changes", () => {
    const repository = { activitySamples: vi.fn(() => []) };
    const cache = new PlayerActivityCache(repository);
    for (let id = 0; id < 33; id++) cache.hours([String(id)], "UTC", 1_000, 10_000);
    repository.activitySamples.mockClear();
    cache.hours(["0"], "UTC", 1_000, 10_000);
    cache.hours(["0"], "UTC", 1_000, 9_999);
    cache.hours(["0"], "UTC", 2_000, 9_999);
    expect(repository.activitySamples).toHaveBeenCalledTimes(3);
  });
});
