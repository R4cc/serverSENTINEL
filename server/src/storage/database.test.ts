import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { currentSchemaName, currentSchemaVersion, openStorageDatabase, type StorageDatabase } from "./database.js";

const legacySchema16Migrations = [
  "sqlite-foundation",
  "users-nodes-settings-sessions",
  "managed-servers-schedules",
  "file-edit-leases",
  "resource-stats-history",
  "mod-preferences",
  "operations",
  "server-restart-required",
  "node-build-id",
  "schedule-command-delays",
  "schedule-command-delay-seconds",
  "server-restart-required-mods",
  "server-desired-runtime-state",
  "schedule-steps",
  "runtime-lifecycle-intent",
  "scheduled-run-details"
] as const;

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

function seedMigrationHistory(database: Database.Database, count: number) {
  database.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);
  const insert = database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  legacySchema16Migrations.slice(0, count).forEach((name, index) => insert.run(index + 1, name, "2026-01-01T00:00:00.000Z"));
}

function seedLegacySchema16(path: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  openStorageDatabase(path).close();
  const database = new Database(path);
  database.exec(`
    ALTER TABLE nodes ADD COLUMN compatibility TEXT;
    ALTER TABLE servers ADD COLUMN desired_runtime_state TEXT CHECK (desired_runtime_state IS NULL OR desired_runtime_state IN ('running', 'stopped'));
    DROP TABLE schedules;
    CREATE TABLE schedules (
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      id TEXT NOT NULL,
      name TEXT NOT NULL,
      cron TEXT NOT NULL,
      commands_json TEXT NOT NULL,
      only_when_no_players INTEGER NOT NULL,
      enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_run_at TEXT,
      last_status TEXT,
      last_message TEXT,
      command_delays_json TEXT NOT NULL DEFAULT '[]',
      command_delays_seconds_json TEXT NOT NULL DEFAULT '[]',
      steps_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (server_id, id)
    );
    CREATE INDEX schedules_enabled_idx ON schedules(enabled);
    DELETE FROM schema_migrations;
  `);
  const insertMigration = database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)");
  legacySchema16Migrations.forEach((name, index) => insertMigration.run(index + 1, name, "2026-01-01T00:00:00.000Z"));
  database.prepare("INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at, protocol_version, capabilities_json, compatibility) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("node-1", "Node", "remote", "offline", 0, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2.0", "[]", "compatible");
  database.prepare("INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, created_at, updated_at, desired_runtime_state, runtime_intent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("server-1", "node-1", "Server", "/data/server-1", "{}", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "running", "running");
  database.prepare("INSERT INTO schedules (server_id, id, name, cron, commands_json, command_delays_json, command_delays_seconds_json, steps_json, only_when_no_players, enabled, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("server-1", "schedule-1", "Restart", "0 4 * * *", "[\"stop\"]", "[1]", "[60]", "[{\"type\":\"command\",\"command\":\"stop\",\"delaySeconds\":60}]", 0, 1, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  database.prepare("INSERT INTO storage_metadata (key, value) VALUES (?, ?)").run("preserved", "metadata");
  database.prepare("INSERT INTO scheduled_runs (id, server_id, schedule_id, schedule_name, status, ran_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("run-1", "server-1", "schedule-1", "Restart", "completed", "2026-01-01T04:00:00.000Z", "{\"stepCount\":1}");
  database.close();
}

describe("SQLite storage", () => {
  it("creates the compact current schema and configures the connection", async () => {
    const path = await temporaryDatabasePath();
    const storage = openStorageDatabase(path);
    openDatabases.push(storage);

    expect(existsSync(path)).toBe(true);
    expect(storage.connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(storage.connection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(storage.connection.pragma("busy_timeout", { simple: true })).toBe(5_000);
    expect(storage.connection.prepare("SELECT version, name FROM schema_migrations").get())
      .toEqual({ version: currentSchemaVersion, name: currentSchemaName });
    expect(columnNames(storage.connection, "nodes")).not.toContain("compatibility");
    expect(columnNames(storage.connection, "servers")).not.toContain("desired_runtime_state");
    expect(columnNames(storage.connection, "schedules")).toEqual(expect.arrayContaining(["steps_json"]));
    expect(columnNames(storage.connection, "schedules")).not.toEqual(expect.arrayContaining(["commands_json", "command_delays_json", "command_delays_seconds_json"]));
  });

  it("initializes the compact schema idempotently", async () => {
    const path = await temporaryDatabasePath();
    openStorageDatabase(path).close();

    const second = openStorageDatabase(path);
    openDatabases.push(second);
    expect(second.connection.prepare("SELECT version, name FROM schema_migrations").all())
      .toEqual([{ version: currentSchemaVersion, name: currentSchemaName }]);
  });

  it("compacts a complete schema-16 database without losing canonical data", async () => {
    const path = await temporaryDatabasePath();
    seedLegacySchema16(path);

    const storage = openStorageDatabase(path);
    openDatabases.push(storage);

    expect(storage.connection.prepare("SELECT version, name FROM schema_migrations").all())
      .toEqual([{ version: currentSchemaVersion, name: currentSchemaName }]);
    expect(storage.connection.prepare("SELECT id, protocol_version FROM nodes").get()).toEqual({ id: "node-1", protocol_version: "2.0" });
    expect(storage.connection.prepare("SELECT id, runtime_intent FROM servers").get()).toEqual({ id: "server-1", runtime_intent: "running" });
    expect(storage.connection.prepare("SELECT id, steps_json FROM schedules").get()).toEqual({
      id: "schedule-1",
      steps_json: "[{\"type\":\"command\",\"command\":\"stop\",\"delaySeconds\":60}]"
    });
    expect(columnNames(storage.connection, "schedules").at(-1)).toBe("steps_json");
    expect(storage.connection.prepare("SELECT key, value FROM storage_metadata WHERE key = ?").get("preserved")).toEqual({ key: "preserved", value: "metadata" });
    expect(storage.connection.prepare("SELECT id, details_json FROM scheduled_runs").get()).toEqual({ id: "run-1", details_json: "{\"stepCount\":1}" });
    const indexes = storage.connection.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all().map(({ name }) => name);
    expect(indexes).toEqual(expect.arrayContaining(["servers_node_id_idx", "schedules_enabled_idx", "scheduled_runs_schedule_idx"]));
    expect(storage.connection.pragma("foreign_key_check")).toEqual([]);

    storage.close();
    openDatabases.pop();
    const reopened = openStorageDatabase(path);
    openDatabases.push(reopened);
    expect(reopened.connection.prepare("SELECT version, name FROM schema_migrations").all())
      .toEqual([{ version: currentSchemaVersion, name: currentSchemaName }]);
  });

  it("rejects pre-16 databases without changing their migration history", async () => {
    const path = await temporaryDatabasePath();
    mkdirSync(join(path, ".."), { recursive: true });
    const legacy = new Database(path);
    seedMigrationHistory(legacy, 15);
    legacy.close();

    expect(() => openStorageDatabase(path)).toThrow(/1\.2\.1 first/);
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.prepare("SELECT MAX(version) AS version FROM schema_migrations").get()).toEqual({ version: 15 });
    unchanged.close();
  });

  it("rejects unknown future migration history", async () => {
    const path = await temporaryDatabasePath();
    mkdirSync(join(path, ".."), { recursive: true });
    const database = new Database(path);
    database.exec(`CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(18, "future-schema", "2026-01-01T00:00:00.000Z");
    database.close();

    expect(() => openStorageDatabase(path)).toThrow(/newer than/);
    const unchanged = new Database(path, { readonly: true });
    expect(unchanged.prepare("SELECT version, name FROM schema_migrations").get()).toEqual({ version: 18, name: "future-schema" });
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
