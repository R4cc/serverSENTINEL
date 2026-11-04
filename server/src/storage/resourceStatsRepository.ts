import type { ResourceStatsSample } from "../resourceStatsCollector.js";
import type { StorageDatabase } from "./database.js";

type ResourceStatsRow = { sample_json: string };

const parseSample = (json: string) => JSON.parse(json) as ResourceStatsSample;

export class ResourceStatsRepository {
  constructor(private readonly storage: StorageDatabase) {}

  list(serverId: string, cutoff: number): ResourceStatsSample[] {
    return this.storage.connection.prepare<[string, number], string>(`
      SELECT sample_json FROM resource_stats
      WHERE server_id = ? AND sampled_at >= ?
      ORDER BY sampled_at
    `).pluck().all(serverId, cutoff).map(parseSample);
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
    // Plucking the one column skips building a row object per sample, which a seven-day window
    // otherwise does about 120,000 times before parsing.
    const rows = this.storage.connection.prepare<[string, number, number], string>(`
      SELECT sample_json FROM resource_stats
      WHERE server_id = ? AND sampled_at >= ? AND sampled_at <= ?
      ORDER BY sampled_at
    `).pluck().all(serverId, from, to).map(parseSample);
    if (!includePrevious) return rows;
    const previous = this.storage.connection.prepare<[string, number], ResourceStatsRow>(`
      SELECT sample_json FROM resource_stats
      WHERE server_id = ? AND sampled_at < ?
      ORDER BY sampled_at DESC LIMIT 1
    `).get(serverId, from);
    if (previous) rows.unshift(parseSample(previous.sample_json));
    return rows;
  }

  latest(serverId: string) {
    const row = this.storage.connection.prepare<[string], ResourceStatsRow>(`
      SELECT sample_json FROM resource_stats WHERE server_id = ? ORDER BY sampled_at DESC LIMIT 1
    `).get(serverId);
    return row ? JSON.parse(row.sample_json) as ResourceStatsSample : undefined;
  }

  /** SQLite's single MAX selects the other column from that same newest valid row. */
  activitySamples(serverId: string, from: number, to: number) {
    return this.storage.connection.prepare<[string, number, number], { sampledAt: number; playersOnline: number }>(`
      SELECT MAX(sampled_at) AS sampledAt, json_extract(sample_json, '$.playersOnline') AS playersOnline
      FROM resource_stats
      WHERE server_id = ? AND sampled_at >= ? AND sampled_at <= ?
        AND json_type(sample_json, '$.playersOnline') IN ('integer', 'real')
      GROUP BY CAST((sampled_at + 5000) / 10000 AS INTEGER)
    `).all(serverId, from, to);
  }

  /**
   * The newest sample in each of `points` equal slices of [from, to], for series that keep only that
   * sample per slice. Parsing the whole window instead decoded every retained row -- about 120,000 for
   * seven days -- to keep at most `points` of them. The slice index repeats the float arithmetic of
   * `playerLatencyHistory` so both sides agree on which slice a boundary sample belongs to.
   *
   * The slices are chosen from the primary-key index alone and only the chosen rows are read back;
   * carrying `sample_json` through the grouping read every row of the window from the table.
   * CROSS JOIN pins that order: left to the planner, the ORDER BY made it scan every row of the
   * server and re-run the grouping for each one.
   */
  latestPerSlice(serverId: string, from: number, to: number, points: number): ResourceStatsSample[] {
    if (points < 1 || to <= from) return [];
    return this.storage.connection.prepare<[string, number, number, number, number, number, number, string], string>(`
      SELECT stats.sample_json FROM (
        SELECT MAX(sampled_at) AS sampled_at FROM resource_stats
        WHERE server_id = ? AND sampled_at >= ? AND sampled_at <= ?
        GROUP BY MIN(? - 1, CAST(((sampled_at - ?) * 1.0 / ?) * ? AS INTEGER))
      ) AS newest
      CROSS JOIN resource_stats AS stats ON stats.server_id = ? AND stats.sampled_at = newest.sampled_at
      ORDER BY newest.sampled_at
    `).pluck().all(serverId, from, to, points, from, to - from, points, serverId).map(parseSample);
  }

  recent(serverId: string, cutoff: number, limit: number): ResourceStatsSample[] {
    return this.storage.connection.prepare<[string, number, number], ResourceStatsRow>(`
      SELECT sample_json FROM resource_stats WHERE server_id = ? AND sampled_at >= ?
      ORDER BY sampled_at DESC LIMIT ?
    `).all(serverId, cutoff, limit).reverse().map((row) => JSON.parse(row.sample_json) as ResourceStatsSample);
  }

  prune(cutoff: number) {
    return this.storage.connection.prepare("DELETE FROM resource_stats WHERE sampled_at < ?").run(cutoff).changes;
  }
}
