import type { ResourceStatsSample } from "../resourceStatsCollector.js";
import type { StorageDatabase } from "./database.js";

type ResourceStatsRow = { sample_json: string };

export class ResourceStatsRepository {
  constructor(private readonly storage: StorageDatabase) {}

  list(serverId: string, cutoff: number): ResourceStatsSample[] {
    return this.storage.connection.prepare<[string, number], ResourceStatsRow>(`
      SELECT sample_json FROM resource_stats
      WHERE server_id = ? AND sampled_at >= ?
      ORDER BY sampled_at
    `).all(serverId, cutoff).map((row) => JSON.parse(row.sample_json) as ResourceStatsSample);
  }

  append(serverId: string, sample: ResourceStatsSample, cutoff: number) {
    this.storage.transaction((database) => {
      database.prepare(`
        INSERT INTO resource_stats (server_id, sampled_at, sample_json) VALUES (?, ?, ?)
        ON CONFLICT(server_id, sampled_at) DO UPDATE SET sample_json = excluded.sample_json
      `).run(serverId, sample.sampledAt, JSON.stringify(sample));
      database.prepare("DELETE FROM resource_stats WHERE server_id = ? AND sampled_at < ?").run(serverId, cutoff);
    });
  }

  listRange(serverId: string, from: number, to: number, includePrevious = false): ResourceStatsSample[] {
    const rows = this.storage.connection.prepare<[string, number, number], ResourceStatsRow>(`
      SELECT sample_json FROM resource_stats
      WHERE server_id = ? AND sampled_at >= ? AND sampled_at <= ?
      ORDER BY sampled_at
    `).all(serverId, from, to).map((row) => JSON.parse(row.sample_json) as ResourceStatsSample);
    if (!includePrevious) return rows;
    const previous = this.storage.connection.prepare<[string, number], ResourceStatsRow>(`
      SELECT sample_json FROM resource_stats
      WHERE server_id = ? AND sampled_at < ?
      ORDER BY sampled_at DESC LIMIT 1
    `).get(serverId, from);
    return previous ? [JSON.parse(previous.sample_json) as ResourceStatsSample, ...rows] : rows;
  }

  latest(serverId: string) {
    const row = this.storage.connection.prepare<[string], ResourceStatsRow>(`
      SELECT sample_json FROM resource_stats WHERE server_id = ? ORDER BY sampled_at DESC LIMIT 1
    `).get(serverId);
    return row ? JSON.parse(row.sample_json) as ResourceStatsSample : undefined;
  }

  prune(cutoff: number) {
    return this.storage.connection.prepare("DELETE FROM resource_stats WHERE sampled_at < ?").run(cutoff).changes;
  }
}
