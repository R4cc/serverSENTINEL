import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { currentSchemaName, currentSchemaVersion, oldestSupportedSchemaVersion, openStorageDatabase, type StorageDatabase } from "./database.js";

const temporaryDirectories: string[] = [];
const openDatabases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryDatabasePath() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-sqlite-"));
  temporaryDirectories.push(root);
  return join(root, "nested", "serversentinel.sqlite");
}

function columnNames(database: Database.Database, table: string) {
  return database.prepare(`PRAGMA table_info('${table}')`).all().map((column) => (column as { name: string }).name);
}

function seedSchemaHistory(path: string, version: number, name = currentSchemaName) {
  mkdirSync(join(path, ".."), { recursive: true });
  const database = new Database(path);
  database.exec("CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
  database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
    .run(version, name, "2026-01-01T00:00:00.000Z");
  database.close();
}

describe("SQLite storage", () => {
  it("creates the current schema and configures the connection", async () => {
    const path = await temporaryDatabasePath();
    const storage = openStorageDatabase(path);
    openDatabases.push(storage);

    expect(existsSync(path)).toBe(true);
    expect(storage.connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(storage.connection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(storage.connection.pragma("busy_timeout", { simple: true })).toBe(5_000);
    expect(storage.connection.prepare("SELECT version, name FROM schema_migrations").get())
      .toEqual({ version: currentSchemaVersion, name: currentSchemaName });
    expect(columnNames(storage.connection, "servers")).toContain("start_on_node_start");
    expect(columnNames(storage.connection, "schedules")).toContain("steps_json");
    expect(columnNames(storage.connection, "app_settings")).toEqual(["id", "modrinth_api_key", "player_heads_enabled", "player_heads_onboarding_completed", "maxmind_account_id", "maxmind_license_key"]);
    expect(columnNames(storage.connection, "player_head_cache")).toEqual(["cache_key", "player_name", "png_bytes", "etag", "fetched_at", "refresh_after", "last_accessed_at"]);
    // Player Insights stores where a player connected from and never what they connected from.
    expect(columnNames(storage.connection, "player_geo_locations")).toEqual(["server_id", "player_key", "player_name", "location_json", "first_seen_at", "last_seen_at", "observations"]);
    expect(columnNames(storage.connection, "player_geo_locations").join(" ")).not.toMatch(/address|ip_/);
  });

  it("opens the current schema idempotently", async () => {
    const path = await temporaryDatabasePath();
    openStorageDatabase(path).close();

    const reopened = openStorageDatabase(path);
    openDatabases.push(reopened);
    expect(reopened.connection.prepare("SELECT version, name FROM schema_migrations").all())
      .toEqual([{ version: currentSchemaVersion, name: currentSchemaName }]);
  });

  /**
   * Undoes what schema 23 changed: the geography table goes back to one row per player, which is
   * what release 22 wrote before latency history had to be reconstructed from past locations.
   */
  function revertToSchema22(path: string) {
    const old = new Database(path);
    old.exec(`
      CREATE TABLE player_geo_locations_22 (
        server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
        player_key TEXT NOT NULL,
        player_name TEXT NOT NULL,
        location_json TEXT NOT NULL,
        first_seen_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL,
        observations INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (server_id, player_key)
      );
      INSERT INTO player_geo_locations_22 SELECT * FROM player_geo_locations;
      DROP TABLE player_geo_locations;
      ALTER TABLE player_geo_locations_22 RENAME TO player_geo_locations;
      CREATE INDEX player_geo_locations_last_seen_idx ON player_geo_locations(server_id, last_seen_at);
      UPDATE schema_migrations SET version = 22;
    `);
    old.close();
  }

  /** Undoes everything schema 22 added, so the file on disk is what release 21 actually wrote. */
  function revertToSchema21(path: string) {
    revertToSchema22(path);
    const old = new Database(path);
    old.exec(`
      ALTER TABLE app_settings DROP COLUMN maxmind_account_id;
      ALTER TABLE app_settings DROP COLUMN maxmind_license_key;
      DROP TABLE player_geo_locations;
      UPDATE schema_migrations SET version = 21;
    `);
    old.close();
  }

  function seedServer(path: string) {
    const database = new Database(path);
    database.prepare("INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at) VALUES ('local', 'Internal', 'local', 'online', 1, '2026-01-01', '2026-01-01')").run();
    database.prepare(`
      INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, created_at, updated_at)
      VALUES ('server-1', 'local', 'Survival', '/servers/survival', '{}', '2026-01-01', '2026-01-01')
    `).run();
    database.close();
  }

  it("migrates schema 22 to a geography history, carrying existing rows across", async () => {
    const path = await temporaryDatabasePath();
    openStorageDatabase(path).close();
    seedServer(path);
    revertToSchema22(path);

    const legacy = new Database(path);
    legacy.prepare(`
      INSERT INTO player_geo_locations (server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations)
      VALUES ('server-1', 'sullythesnak', 'SullyTheSnak', '{"label":"Copenhagen","precision":"city"}', 1000, 9000, 4)
    `).run();
    legacy.close();

    const migrated = openStorageDatabase(path);
    openDatabases.push(migrated);
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations").get())
      .toEqual({ version: currentSchemaVersion });
    // The row survives exactly as recorded: the one run it describes, and nothing invented before it.
    expect(migrated.connection.prepare("SELECT player_name, first_seen_at, last_seen_at, observations FROM player_geo_locations").all())
      .toEqual([{ player_name: "SullyTheSnak", first_seen_at: 1000, last_seen_at: 9000, observations: 4 }]);

    // The new key admits a second run for the same player, which the old one silently replaced.
    migrated.connection.prepare(`
      INSERT INTO player_geo_locations (server_id, player_key, player_name, location_json, first_seen_at, last_seen_at, observations)
      VALUES ('server-1', 'sullythesnak', 'SullyTheSnak', '{"label":"Sydney","precision":"city"}', 12000, 12000, 1)
    `).run();
    expect(migrated.connection.prepare<[], { total: number }>("SELECT COUNT(*) AS total FROM player_geo_locations").get()?.total).toBe(2);
  });

  it("migrates schema 21 for Player Insights geography", async () => {
    const path = await temporaryDatabasePath();
    openStorageDatabase(path).close();
    revertToSchema21(path);

    const migrated = openStorageDatabase(path);
    openDatabases.push(migrated);
    expect(columnNames(migrated.connection, "app_settings")).toContain("maxmind_license_key");
    expect(columnNames(migrated.connection, "player_geo_locations")).toContain("location_json");
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations").get())
      .toEqual({ version: currentSchemaVersion });
  });

  it("migrates schema 20 for quarantined import port conflicts", async () => {
    const path = await temporaryDatabasePath();
    openStorageDatabase(path).close();
    revertToSchema21(path);
    const old = new Database(path);
    old.exec(`
      ALTER TABLE servers DROP COLUMN port_conflict_unresolved;
      CREATE UNIQUE INDEX managed_ports_node_port_unique
        ON managed_ports(node_id, external_port, protocol);
      UPDATE schema_migrations SET version = 20;
    `);
    old.close();

    // A data root that skipped a release has to pass through every migration between it and the
    // current baseline, so this one arrives with both the port fix and the Player Insights tables.
    const migrated = openStorageDatabase(path);
    openDatabases.push(migrated);
    expect(columnNames(migrated.connection, "servers")).toContain("port_conflict_unresolved");
    expect(columnNames(migrated.connection, "player_geo_locations")).toContain("location_json");
    expect(migrated.connection.prepare("SELECT version FROM schema_migrations").get())
      .toEqual({ version: currentSchemaVersion });
    expect(migrated.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'managed_ports_node_port_unique'").get())
      .toBeUndefined();
  });

  it("rejects schemas older than the 1.6.2 floor without changing history", async () => {
    const path = await temporaryDatabasePath();
    seedSchemaHistory(path, oldestSupportedSchemaVersion - 1);

    expect(() => openStorageDatabase(path)).toThrow(/1\.6\.2 first/);
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.prepare("SELECT version, name FROM schema_migrations").get())
      .toEqual({ version: oldestSupportedSchemaVersion - 1, name: currentSchemaName });
    unchanged.close();
  });

  it("rejects unknown future migration history", async () => {
    const path = await temporaryDatabasePath();
    seedSchemaHistory(path, currentSchemaVersion + 1, "future-schema");

    expect(() => openStorageDatabase(path)).toThrow(/newer than/);
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.prepare("SELECT version, name FROM schema_migrations").get())
      .toEqual({ version: currentSchemaVersion + 1, name: "future-schema" });
    unchanged.close();
  });

  it("rejects malformed databases without creating migration metadata", async () => {
    const path = await temporaryDatabasePath();
    mkdirSync(join(path, ".."), { recursive: true });
    const database = new Database(path);
    database.exec("CREATE TABLE unexpected_data (value TEXT NOT NULL)");
    database.prepare("INSERT INTO unexpected_data (value) VALUES (?)").run("preserve-me");
    database.close();

    expect(() => openStorageDatabase(path)).toThrow(/schema_migrations is missing/);
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.prepare("SELECT value FROM unexpected_data").get()).toEqual({ value: "preserve-me" });
    expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()).toBeUndefined();
    unchanged.close();
  });
});
