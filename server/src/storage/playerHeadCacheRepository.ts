import type { StorageDatabase } from "./database.js";

export type PlayerHeadCacheEntry = {
  key: string;
  playerName: string;
  bytes: Buffer;
  etag?: string;
  fetchedAt: number;
  refreshAfter: number;
  lastAccessedAt: number;
};

export type PlayerHeadCacheStats = {
  entries: number;
  bytes: number;
};

type PlayerHeadCacheRow = {
  cache_key: string;
  player_name: string;
  png_bytes: Buffer;
  etag: string | null;
  fetched_at: number;
  refresh_after: number;
  last_accessed_at: number;
};

function entry(row: PlayerHeadCacheRow): PlayerHeadCacheEntry {
  return {
    key: row.cache_key,
    playerName: row.player_name,
    bytes: row.png_bytes,
    etag: row.etag || undefined,
    fetchedAt: row.fetched_at,
    refreshAfter: row.refresh_after,
    lastAccessedAt: row.last_accessed_at
  };
}

export class PlayerHeadCacheRepository {
  constructor(private readonly storage: StorageDatabase) {}

  get(key: string, accessedAt: number) {
    const row = this.storage.connection.prepare<[string], PlayerHeadCacheRow>(`
      SELECT cache_key, player_name, png_bytes, etag, fetched_at, refresh_after, last_accessed_at
      FROM player_head_cache WHERE cache_key = ? COLLATE NOCASE
    `).get(key);
    if (!row) return undefined;
    this.storage.connection.prepare("UPDATE player_head_cache SET last_accessed_at = ? WHERE cache_key = ? COLLATE NOCASE")
      .run(accessedAt, key);
    return { ...entry(row), lastAccessedAt: accessedAt };
  }

  set(value: PlayerHeadCacheEntry) {
    this.storage.connection.prepare(`
      INSERT INTO player_head_cache (
        cache_key, player_name, png_bytes, etag, fetched_at, refresh_after, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        player_name = excluded.player_name,
        png_bytes = excluded.png_bytes,
        etag = excluded.etag,
        fetched_at = excluded.fetched_at,
        refresh_after = excluded.refresh_after,
        last_accessed_at = excluded.last_accessed_at
    `).run(value.key, value.playerName, value.bytes, value.etag ?? null, value.fetchedAt, value.refreshAfter, value.lastAccessedAt);
  }

  markRefreshed(key: string, fetchedAt: number, refreshAfter: number, etag?: string) {
    this.storage.connection.prepare(`
      UPDATE player_head_cache
      SET fetched_at = ?, refresh_after = ?, last_accessed_at = ?, etag = COALESCE(?, etag)
      WHERE cache_key = ? COLLATE NOCASE
    `).run(fetchedAt, refreshAfter, fetchedAt, etag ?? null, key);
  }

  stats(): PlayerHeadCacheStats {
    const row = this.storage.connection.prepare<[], { entries: number; bytes: number }>(`
      SELECT COUNT(*) AS entries, COALESCE(SUM(LENGTH(png_bytes)), 0) AS bytes FROM player_head_cache
    `).get();
    return { entries: row?.entries ?? 0, bytes: row?.bytes ?? 0 };
  }

  clear() {
    this.storage.connection.prepare("DELETE FROM player_head_cache").run();
  }

  enforceLimits(maxEntries: number, maxBytes: number) {
    let current = this.stats();
    while (current.entries > maxEntries || current.bytes > maxBytes) {
      const excessEntries = Math.max(1, current.entries - maxEntries);
      const deleteCount = Math.min(100, excessEntries);
      this.storage.connection.prepare(`
        DELETE FROM player_head_cache WHERE cache_key IN (
          SELECT cache_key FROM player_head_cache ORDER BY last_accessed_at ASC, cache_key ASC LIMIT ?
        )
      `).run(deleteCount);
      current = this.stats();
    }
    return current;
  }
}
