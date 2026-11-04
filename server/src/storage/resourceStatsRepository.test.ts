import { afterEach, describe, expect, it } from "vitest";
import type { ResourceStatsSample } from "../resourceStatsCollector.js";
import { playerLatencyHistory } from "../players/playerInsights.js";
import { openStorageDatabase, type StorageDatabase } from "./database.js";
import { ResourceStatsRepository } from "./resourceStatsRepository.js";

let storage: StorageDatabase | undefined;
afterEach(() => storage?.close());

function sample(sampledAt: number, playersOnline: number, playerPingMs: number[]): ResourceStatsSample {
  return { sampledAt, playersOnline, playerPingMs, available: true, running: true, cpuPercent: 0, memoryUsageBytes: 0, memoryLimitBytes: 0, readAt: new Date(sampledAt).toISOString() };
}

function repositoryWith(history: Record<string, ResourceStatsSample[]>) {
  storage = openStorageDatabase(":memory:");
  storage.connection.prepare("INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at) VALUES ('local', 'Local', 'local', 'online', 1, '', '')").run();
  const repository = new ResourceStatsRepository(storage);
  for (const [id, samples] of Object.entries(history)) {
    storage.connection.prepare("INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, created_at, updated_at) VALUES (?, 'local', ?, ?, '{}', '', '')").run(id, id, id);
    for (const entry of samples) repository.append(id, entry, 0);
  }
  return repository;
}

describe("resource stats slices", () => {
  it("keeps exactly the samples the latency series would choose from the full window", () => {
    // Uneven spans, irregular sample spacing and samples exactly on slice edges exercise the
    // float slice arithmetic that the query must reproduce.
    const from = 1_000_003;
    const to = from + 60 * 60 * 1000 + 17;
    const points = 96;
    const span = to - from;
    const history: Record<string, ResourceStatsSample[]> = { a: [], b: [] };
    let seed = 7;
    const next = () => (seed = (seed * 48_271) % 2_147_483_647);
    for (let at = from - 20_000; at <= to + 20_000; at += 1_000 + next() % 9_000) {
      history.a.push(sample(at, next() % 30, [next() % 200, next() % 200]));
    }
    for (let slice = 0; slice <= points; slice += 1) {
      const edge = from + Math.ceil((span * slice) / points);
      for (const at of [edge - 1, edge]) history.b.push(sample(at, slice % 5, [slice + 1]));
    }
    history.b.push(sample(to, 9, [42]));
    const repository = repositoryWith(history);

    for (const id of ["a", "b"]) {
      const sliced = repository.latestPerSlice(id, from, to, points);
      expect(sliced.length).toBeLessThanOrEqual(points);
      expect(playerLatencyHistory({ resourceSamples: { [id]: sliced }, from, to, points }))
        .toEqual(playerLatencyHistory({ resourceSamples: { [id]: repository.listRange(id, from, to) }, from, to, points }));
    }
    expect(playerLatencyHistory({ resourceSamples: { a: repository.latestPerSlice("a", from, to, points), b: repository.latestPerSlice("b", from, to, points) }, from, to, points }))
      .toEqual(playerLatencyHistory({ resourceSamples: { a: repository.listRange("a", from, to), b: repository.listRange("b", from, to) }, from, to, points }));
  });

  it("returns nothing for an empty or inverted window", () => {
    const repository = repositoryWith({ a: [sample(5_000, 1, [10])] });
    expect(repository.latestPerSlice("a", 5_000, 5_000, 96)).toEqual([]);
    expect(repository.latestPerSlice("a", 6_000, 5_000, 96)).toEqual([]);
    expect(repository.latestPerSlice("a", 0, 10_000, 0)).toEqual([]);
    expect(repository.latestPerSlice("a", 0, 10_000, 96)).toEqual([sample(5_000, 1, [10])]);
  });
});
