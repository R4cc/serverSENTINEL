import type { PlayerLocation } from "@serversentinel/contracts";
import type { StorageDatabase } from "./database.js";

/**
 * Where Player Insights keeps what it derived, and — as importantly — what it does not keep.
 *
 * One row per player per server, holding the place their last join resolved to. The address that
 * resolution started from is never written here, so this table cannot answer "which IP was this
 * player on"; it can only answer "roughly where in the world do this server's players connect
 * from", which is the whole question the feature exists to answer.
 */

export type StoredPlayerGeo = {
  serverId: string;
  player: string;
  playerKey: string;
  location: PlayerLocation;
  firstSeenAt: number;
  lastSeenAt: number;
  observations: number;
};

type PlayerGeoRow = {
  server_id: string;
  player_key: string;
  player_name: string;
  location_json: string;
  first_seen_at: number;
  last_seen_at: number;
  observations: number;
};

export function playerGeoKey(player: string) {
  return player.trim().toLocaleLowerCase("en-US");
}

function fromRow(row: PlayerGeoRow): StoredPlayerGeo | undefined {
  try {
    return {
      serverId: row.server_id,
      player: row.player_name,
      playerKey: row.player_key,
      location: JSON.parse(row.location_json) as PlayerLocation,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      observations: row.observations
    };
  } catch {
    // A row this build cannot read is treated as absent rather than failing the whole page.
    return undefined;
  }
}

export class PlayerGeoRepository {
  constructor(private readonly storage: StorageDatabase) {}

  list(): StoredPlayerGeo[] {
    return this.storage.connection.prepare<[], PlayerGeoRow>(`
      SELECT server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations
      FROM player_geo_locations
      ORDER BY last_seen_at DESC
    `).all().map(fromRow).filter((entry): entry is StoredPlayerGeo => Boolean(entry));
  }

  listForServer(serverId: string): StoredPlayerGeo[] {
    return this.storage.connection.prepare<[string], PlayerGeoRow>(`
      SELECT server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations
      FROM player_geo_locations
      WHERE server_id = ?
      ORDER BY last_seen_at DESC
    `).all(serverId).map(fromRow).filter((entry): entry is StoredPlayerGeo => Boolean(entry));
  }

  find(serverId: string, player: string) {
    const row = this.storage.connection.prepare<[string, string], PlayerGeoRow>(`
      SELECT server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations
      FROM player_geo_locations
      WHERE server_id = ? AND player_key = ?
    `).get(serverId, playerGeoKey(player));
    return row ? fromRow(row) : undefined;
  }

  /**
   * Records the location one join resolved to.
   *
   * The same login line is read again on every poll of the log window, so this is keyed on the
   * player rather than the join: re-seeing a join refreshes `last_seen_at` and leaves the count
   * alone, and only a genuinely new join — one later than the last recorded — counts as another
   * observation.
   */
  record(entry: { serverId: string; player: string; location: PlayerLocation; at: number }) {
    const key = playerGeoKey(entry.player);
    if (!key) return;
    this.storage.connection.prepare(`
      INSERT INTO player_geo_locations (server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(server_id, player_key) DO UPDATE SET
        player_name = excluded.player_name,
        location_json = excluded.location_json,
        last_seen_at = MAX(player_geo_locations.last_seen_at, excluded.last_seen_at),
        observations = player_geo_locations.observations + (excluded.last_seen_at > player_geo_locations.last_seen_at)
    `).run(entry.serverId, key, entry.player.trim(), JSON.stringify(entry.location), entry.at, entry.at);
  }

  /** Retention: geography older than the cutoff stops describing who plays here now. */
  prune(cutoff: number) {
    return this.storage.connection.prepare("DELETE FROM player_geo_locations WHERE last_seen_at < ?").run(cutoff).changes;
  }

  clear(serverId?: string) {
    return serverId
      ? this.storage.connection.prepare("DELETE FROM player_geo_locations WHERE server_id = ?").run(serverId).changes
      : this.storage.connection.prepare("DELETE FROM player_geo_locations").run().changes;
  }

  stats() {
    const row = this.storage.connection.prepare<[], { entries: number; servers: number }>(`
      SELECT COUNT(*) AS entries, COUNT(DISTINCT server_id) AS servers FROM player_geo_locations
    `).get();
    return { entries: row?.entries ?? 0, servers: row?.servers ?? 0 };
  }
}
