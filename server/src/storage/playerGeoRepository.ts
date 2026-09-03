import type { PlayerLocation } from "@serversentinel/contracts";
import type { StorageDatabase } from "./database.js";

/**
 * Where Player Insights keeps what it derived, and — as importantly — what it does not keep.
 *
 * The address a Minecraft server logs at login is resolved in memory and dropped. This table holds
 * only the derived place and a bounded RTT aggregate, so it cannot answer "which IP was this player
 * on"; it can answer roughly where players connect from and what their latest session felt like.
 *
 * One current derived place is retained per player. Existing installations may still have several
 * legacy rows; reads collapse those rows while new observations update only the latest one.
 */

export type StoredPlayerGeo = {
  serverId: string;
  player: string;
  playerKey: string;
  location: PlayerLocation;
  firstSeenAt: number;
  lastSeenAt: number;
  observations: number;
  /** Rolling average from the player's most recently measured online session. */
  lastPingAverageMs?: number;
  lastPingSamples?: number;
  lastPingAt?: number;
};

type PlayerGeoRow = {
  server_id: string;
  player_key: string;
  player_name: string;
  location_json: string;
  first_seen_at: number;
  last_seen_at: number;
  observations: number;
  last_ping_average_ms: number | null;
  last_ping_samples: number;
  last_ping_at: number | null;
};

export function playerGeoKey(player: string) {
  return player.trim().toLocaleLowerCase("en-US");
}

function parseLocation(json: string) {
  try {
    return JSON.parse(json) as PlayerLocation;
  } catch {
    // A row this build cannot read is treated as absent rather than failing the whole page.
    return undefined;
  }
}

function group(rows: PlayerGeoRow[]): StoredPlayerGeo[] {
  const byPlayer = new Map<string, StoredPlayerGeo>();
  for (const row of rows) {
    const location = parseLocation(row.location_json);
    if (!location) continue;
    const key = `${row.server_id}:${row.player_key}`;
    const existing = byPlayer.get(key);
    if (!existing) {
      byPlayer.set(key, {
        serverId: row.server_id,
        player: row.player_name,
        playerKey: row.player_key,
        location,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        observations: row.observations,
        ...(row.last_ping_average_ms !== null ? { lastPingAverageMs: row.last_ping_average_ms } : {}),
        lastPingSamples: row.last_ping_samples,
        ...(row.last_ping_at !== null ? { lastPingAt: row.last_ping_at } : {})
      });
      continue;
    }
    // Rows arrive oldest first per player, so the last one seen is the current place and carries
    // the name the player most recently used.
    existing.location = location;
    existing.player = row.player_name;
    existing.firstSeenAt = Math.min(existing.firstSeenAt, row.first_seen_at);
    existing.lastSeenAt = Math.max(existing.lastSeenAt, row.last_seen_at);
    existing.observations += row.observations;
    if (row.last_ping_at !== null && (existing.lastPingAt === undefined || row.last_ping_at >= existing.lastPingAt)) {
      existing.lastPingAverageMs = row.last_ping_average_ms ?? undefined;
      existing.lastPingSamples = row.last_ping_samples;
      existing.lastPingAt = row.last_ping_at;
    }
  }
  return [...byPlayer.values()].sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}

export class PlayerGeoRepository {
  constructor(private readonly storage: StorageDatabase) {}

  list(): StoredPlayerGeo[] {
    return group(this.storage.connection.prepare<[], PlayerGeoRow>(`
      SELECT server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations,
        last_ping_average_ms, last_ping_samples, last_ping_at FROM player_geo_locations
      ORDER BY server_id, player_key, first_seen_at
    `).all());
  }

  listForServer(serverId: string): StoredPlayerGeo[] {
    return group(this.storage.connection.prepare<[string], PlayerGeoRow>(`
      SELECT server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations,
        last_ping_average_ms, last_ping_samples, last_ping_at FROM player_geo_locations
      WHERE server_id = ?
      ORDER BY player_key, first_seen_at
    `).all(serverId));
  }

  find(serverId: string, player: string) {
    return group(this.storage.connection.prepare<[string, string], PlayerGeoRow>(`
      SELECT server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations,
        last_ping_average_ms, last_ping_samples, last_ping_at FROM player_geo_locations
      WHERE server_id = ? AND player_key = ?
      ORDER BY first_seen_at
    `).all(serverId, playerGeoKey(player)))[0];
  }

  /**
   * Records the location one join resolved to.
   *
   * The same login line is read again on every poll of the log window, so this is idempotent: a
   * join already recorded refreshes nothing and counts nothing. A newer join updates the player's
   * latest derived place without retaining the connection address or an unused location history.
   *
   * An observation older than the newest run is ignored rather than backdated. It can only be a
   * line the panel has already read, and inserting it would interleave a stale place into a
   * history that has already moved on.
   */
  record(entry: { serverId: string; player: string; location: PlayerLocation; at: number }) {
    const key = playerGeoKey(entry.player);
    if (!key) return;
    const name = entry.player.trim();
    this.storage.transaction((database) => {
      const newest = database.prepare<[string, string], PlayerGeoRow>(`
        SELECT server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations,
          last_ping_average_ms, last_ping_samples, last_ping_at FROM player_geo_locations
        WHERE server_id = ? AND player_key = ?
        ORDER BY first_seen_at DESC LIMIT 1
      `).get(entry.serverId, key);
      if (newest) {
        if (entry.at <= newest.last_seen_at) return;
        database.prepare(`
          UPDATE player_geo_locations
          SET player_name = ?, location_json = ?, last_seen_at = ?, observations = observations + 1
          WHERE server_id = ? AND player_key = ? AND first_seen_at = ?
        `).run(name, JSON.stringify(entry.location), entry.at, entry.serverId, key, newest.first_seen_at);
        return;
      }

      database.prepare(`
        INSERT INTO player_geo_locations (server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(entry.serverId, key, name, JSON.stringify(entry.location), entry.at, entry.at);
    });
  }

  /**
   * Persists one bounded rolling average per measured player in a single transaction.
   *
   * Only the aggregate and its age survive. The endpoint used to match the TCP connection remains
   * in the collector's memory and never reaches storage.
   */
  recordPingAverages(serverId: string, entries: readonly { playerKey: string; averagePingMs: number; samples: number; at: number }[]) {
    const valid = entries.filter((entry) => entry.playerKey
      && Number.isFinite(entry.averagePingMs) && entry.averagePingMs > 0
      && Number.isInteger(entry.samples) && entry.samples > 0
      && Number.isFinite(entry.at) && entry.at > 0);
    if (!valid.length) return 0;
    return this.storage.transaction((database) => {
      const update = database.prepare(`
        UPDATE player_geo_locations
        SET last_ping_average_ms = ?, last_ping_samples = ?, last_ping_at = ?
        WHERE server_id = ? AND player_key = ?
          AND first_seen_at = (
            SELECT MAX(first_seen_at) FROM player_geo_locations
            WHERE server_id = ? AND player_key = ?
          )
          AND (last_ping_at IS NULL OR last_ping_at <= ?)
      `);
      let changes = 0;
      for (const entry of valid) {
        changes += update.run(
          Math.round(entry.averagePingMs), entry.samples, Math.round(entry.at),
          serverId, entry.playerKey, serverId, entry.playerKey, Math.round(entry.at)
        ).changes;
      }
      return changes;
    });
  }

  /**
   * Retention: geography that stopped describing anyone who plays here is dropped.
   *
   * A record is judged by its latest observation, so an active player keeps their derived place.
   */
  prune(cutoff: number) {
    return this.storage.connection.prepare("DELETE FROM player_geo_locations WHERE last_seen_at < ?").run(cutoff).changes;
  }

  clear(serverId?: string) {
    return serverId
      ? this.storage.connection.prepare("DELETE FROM player_geo_locations WHERE server_id = ?").run(serverId).changes
      : this.storage.connection.prepare("DELETE FROM player_geo_locations").run().changes;
  }

  stats() {
    const row = this.storage.connection.prepare<[], { rows: number; players: number; servers: number }>(`
      SELECT COUNT(*) AS rows, COUNT(DISTINCT server_id || ':' || player_key) AS players,
        COUNT(DISTINCT server_id) AS servers
      FROM player_geo_locations
    `).get();
    return { entries: row?.players ?? 0, rows: row?.rows ?? 0, servers: row?.servers ?? 0 };
  }
}
