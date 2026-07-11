import { existsSync, mkdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { currentSchemaVersion, openStorageDatabase, sqliteMigrations, type StorageDatabase } from "./database.js";

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

function seedSchema(path: string, migrationCount: number) {
  mkdirSync(join(path, ".."), { recursive: true });
  const database = new Database(path);
  try {
    database.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    for (const migration of sqliteMigrations.slice(0, migrationCount)) {
      database.transaction(() => {
        migration.up(database);
        database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
          .run(migration.version, migration.name, "2026-01-01T00:00:00.000Z");
      }).immediate();
    }
  } finally {
    database.close();
  }
}

describe("SQLite storage", () => {
  it("creates a fresh database and configures the connection", async () => {
    const path = await temporaryDatabasePath();
    const storage = openStorageDatabase(path);
    openDatabases.push(storage);

    expect(existsSync(path)).toBe(true);
    expect(storage.connection.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(storage.connection.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(storage.connection.pragma("busy_timeout", { simple: true })).toBe(5_000);
    expect(storage.connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
      .toEqual({ version: currentSchemaVersion });
  });

  it("initializes the schema idempotently", async () => {
    const path = await temporaryDatabasePath();
    const first = openStorageDatabase(path);
    first.close();

    const second = openStorageDatabase(path);
    openDatabases.push(second);
    expect(second.connection.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all())
      .toEqual([
        { version: 1, name: "sqlite-foundation" },
        { version: 2, name: "users-nodes-settings-sessions" },
        { version: 3, name: "managed-servers-schedules" },
        { version: 4, name: "file-edit-leases" },
        { version: 5, name: "resource-stats-history" },
        { version: 6, name: "mod-preferences" },
        { version: 7, name: "operations" },
        { version: 8, name: "server-restart-required" },
        { version: 9, name: "node-build-id" },
        { version: 10, name: "schedule-command-delays" },
        { version: 11, name: "schedule-command-delay-seconds" },
        { version: 12, name: "server-restart-required-mods" }
      ]);
  });

  it("migrates from every supported schema prefix to the current schema", async () => {
    for (let migrationCount = 0; migrationCount < sqliteMigrations.length; migrationCount += 1) {
      const path = await temporaryDatabasePath();
      seedSchema(path, migrationCount);
      const storage = openStorageDatabase(path);
      openDatabases.push(storage);

      expect(storage.connection.prepare("SELECT MAX(version) AS version FROM schema_migrations").get())
        .toEqual({ version: currentSchemaVersion });
      expect(storage.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'operations'").get())
        .toEqual({ name: "operations" });
      storage.close();
      openDatabases.pop();
    }
  });

  it("rejects newer or unsupported schema histories", async () => {
    const path = await temporaryDatabasePath();
    seedSchema(path, sqliteMigrations.length);
    const database = new Database(path);
    database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(currentSchemaVersion + 1, "future-schema", "2026-01-01T00:00:00.000Z");
    database.close();

    expect(() => openStorageDatabase(path)).toThrow(/Unsupported SQLite schema migration/);
  });

  it("creates SQLite backups that include uncheckpointed WAL data", async () => {
    const path = await temporaryDatabasePath();
    const storage = openStorageDatabase(path);
    openDatabases.push(storage);
    storage.setMetadata("backup-test", "present only in wal");
    expect(existsSync(`${path}-wal`)).toBe(true);
    expect((await readFile(`${path}-wal`)).length).toBeGreaterThan(0);

    const backupPath = join(join(path, ".."), "backup.sqlite");
    await storage.backupTo(backupPath);
    const backup = openStorageDatabase(backupPath);
    openDatabases.push(backup);

    expect(backup.metadata("backup-test")).toBe("present only in wal");
  });

  it("rolls back explicit transactions when an operation fails", async () => {
    const storage = openStorageDatabase(await temporaryDatabasePath());
    openDatabases.push(storage);

    expect(() => storage.transaction((database) => {
      database.prepare("INSERT INTO storage_metadata (key, value) VALUES (?, ?)").run("test", "value");
      throw new Error("stop");
    })).toThrow("stop");
    expect(storage.connection.prepare("SELECT * FROM storage_metadata").all()).toEqual([]);
  });

  it("stores runtime metadata in SQLite", async () => {
    const storage = openStorageDatabase(await temporaryDatabasePath());
    openDatabases.push(storage);

    expect(storage.metadata("node.identity")).toBeUndefined();

    storage.setMetadata("node.identity", JSON.stringify({ nodeId: "node-1", nodeSecret: "secret" }));
    storage.setMetadata("node.identity", JSON.stringify({ nodeId: "node-1", nodeSecret: "rotated" }));

    expect(storage.metadata("node.identity")).toBe(JSON.stringify({ nodeId: "node-1", nodeSecret: "rotated" }));
  });
});
