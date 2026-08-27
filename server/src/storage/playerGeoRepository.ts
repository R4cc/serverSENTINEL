import type { PlayerLocation } from "@serversentinel/contracts";
import type { StorageDatabase } from "./database.js";

/**
 * Where Player Insights keeps what it derived, and — as importantly — what it does not keep.
 *
 * The address a Minecraft server logs at login is resolved in memory and dropped. This table holds
 * only the place it resolved to, so it cannot answer "which IP was this player on"; it can answer
 * "roughly where in the world do this server's players connect from", which is the whole question
 * the feature exists to answer.
 *
 * What it stores is a short history rather than a single latest place. Estimated latency for a
 * session that happened last Tuesday has to be estimated from where the player was last Tuesday —
 * with one row per player, someone moving across an ocean silently rewrote every past hour of the
 * connection-quality chart. A row is added only when the derived place actually changes, so a
 * player who never moves still costs exactly one row, and this never becomes a time series.
 */

/** One run of joins from the same place. */
export type StoredPlayerGeoStint = {
  location: PlayerLocation;
  firstSeenAt: number;
  lastSeenAt: number;
  observations: number;
};

export type StoredPlayerGeo = {
  serverId: string;
  player: string;
  playerKey: string;
  /** Oldest first. The last entry is where the player is now, as far as the panel knows. */
  stints: StoredPlayerGeoStint[];
  /** The most recent place, which is what the roster shows. */
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

/**
 * How many places one player may be remembered in before the oldest is forgotten.
 *
 * A player on a mobile connection can resolve to a different city every session, and without a
 * ceiling their row count would track their login count. Ten covers any history the panel can
 * actually replay — timeline events are retained for a week — while keeping the table bounded.
 */
export const maxStintsPerPlayer = 10;

export function playerGeoKey(player: string) {
  return player.trim().toLocaleLowerCase("en-US");
}

/** Whether two derived places are the same place, field by field rather than by JSON text. */
export function sameLocation(left: PlayerLocation, right: PlayerLocation) {
  return left.label === right.label
    && left.city === right.city
    && left.subdivision === right.subdivision
    && left.country === right.country
    && left.countryCode === right.countryCode
    && left.continentCode === right.continentCode
    && left.latitude === right.latitude
    && left.longitude === right.longitude
    && left.accuracyRadiusKm === right.accuracyRadiusKm
    && left.precision === right.precision;
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
    const stint: StoredPlayerGeoStint = {
      location,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      observations: row.observations
    };
    const existing = byPlayer.get(key);
    if (!existing) {
      byPlayer.set(key, {
        serverId: row.server_id,
        player: row.player_name,
        playerKey: row.player_key,
        stints: [stint],
        location,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        observations: row.observations
      });
      continue;
    }
    // Rows arrive oldest first per player, so the last one seen is the current place and carries
    // the name the player most recently used.
    existing.stints.push(stint);
    existing.location = location;
    existing.player = row.player_name;
    existing.firstSeenAt = Math.min(existing.firstSeenAt, row.first_seen_at);
    existing.lastSeenAt = Math.max(existing.lastSeenAt, row.last_seen_at);
    existing.observations += row.observations;
  }
  return [...byPlayer.values()].sort((left, right) => right.lastSeenAt - left.lastSeenAt);
}

export class PlayerGeoRepository {
  constructor(private readonly storage: StorageDatabase) {}

  list(): StoredPlayerGeo[] {
    return group(this.storage.connection.prepare<[], PlayerGeoRow>(`
      SELECT server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations FROM player_geo_locations
      ORDER BY server_id, player_key, first_seen_at
    `).all());
  }

  listForServer(serverId: string): StoredPlayerGeo[] {
    return group(this.storage.connection.prepare<[string], PlayerGeoRow>(`
      SELECT server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations FROM player_geo_locations
      WHERE server_id = ?
      ORDER BY player_key, first_seen_at
    `).all(serverId));
  }

  find(serverId: string, player: string) {
    return group(this.storage.connection.prepare<[string, string], PlayerGeoRow>(`
      SELECT server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations FROM player_geo_locations
      WHERE server_id = ? AND player_key = ?
      ORDER BY first_seen_at
    `).all(serverId, playerGeoKey(player)))[0];
  }

  /**
   * Records the location one join resolved to.
   *
   * The same login line is read again on every poll of the log window, so this is idempotent: a
   * join already recorded refreshes nothing and counts nothing. A join from the place the player
   * was last seen in extends that run; a join from somewhere else starts a new one, which is what
   * keeps past latency estimated from past locations.
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
        SELECT server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations FROM player_geo_locations
        WHERE server_id = ? AND player_key = ?
        ORDER BY first_seen_at DESC LIMIT 1
      `).get(entry.serverId, key);
      const newestLocation = newest ? parseLocation(newest.location_json) : undefined;

      if (newest && newestLocation && sameLocation(newestLocation, entry.location)) {
        // The timeline collector republishes the same recent log tail every pass. Once this exact
        // observation has been recorded, do not turn that idempotent replay into a SQLite write.
        if (entry.at <= newest.last_seen_at) return;
        database.prepare(`
          UPDATE player_geo_locations
          SET player_name = ?, last_seen_at = ?, observations = observations + 1
          WHERE server_id = ? AND player_key = ? AND first_seen_at = ?
        `).run(name, entry.at, entry.serverId, key, newest.first_seen_at);
        return;
      }
      if (newest && entry.at <= newest.last_seen_at) return;

      database.prepare(`
        INSERT INTO player_geo_locations (server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations)
        VALUES (?, ?, ?, ?, ?, ?, 1)
        ON CONFLICT(server_id, player_key, first_seen_at) DO UPDATE SET
          player_name = excluded.player_name,
          location_json = excluded.location_json,
          last_seen_at = MAX(player_geo_locations.last_seen_at, excluded.last_seen_at)
      `).run(entry.serverId, key, name, JSON.stringify(entry.location), entry.at, entry.at);

      database.prepare(`
        DELETE FROM player_geo_locations
        WHERE server_id = ? AND player_key = ? AND first_seen_at NOT IN (
          SELECT first_seen_at FROM player_geo_locations
          WHERE server_id = ? AND player_key = ?
          ORDER BY first_seen_at DESC LIMIT ?
        )
      `).run(entry.serverId, key, entry.serverId, key, maxStintsPerPlayer);
    });
  }

  /**
   * Retention: geography that stopped describing anyone who plays here is dropped.
   *
   * A run is judged by when it ended, so a player still connecting from the same place keeps their
   * whole record, and a place someone moved away from ages out on its own.
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
