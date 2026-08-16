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

  /** Undoes everything schema 22 added, so the file on disk is what release 21 actually wrote. */
  function revertToSchema21(path: string) {
    const old = new Database(path);
    old.exec(`
      ALTER TABLE app_settings DROP COLUMN maxmind_account_id;
      ALTER TABLE app_settings DROP COLUMN maxmind_license_key;
      DROP TABLE player_geo_locations;
      UPDATE schema_migrations SET version = 21;
    `);
    old.close();
  }

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
