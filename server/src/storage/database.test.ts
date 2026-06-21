import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { currentSchemaVersion, openStorageDatabase, type StorageDatabase } from "./database.js";

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
        { version: 2, name: "users-nodes-settings-sessions" }
      ]);
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
});
