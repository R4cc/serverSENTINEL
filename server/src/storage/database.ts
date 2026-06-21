import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";

const busyTimeoutMs = 5_000;

type Migration = {
  version: number;
  name: string;
  up: (database: Database.Database) => void;
};

const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "sqlite-foundation",
    up(database) {
      database.exec(`
        CREATE TABLE storage_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        ) WITHOUT ROWID
      `);
    }
  }
];

export const currentSchemaVersion = migrations.at(-1)?.version ?? 0;

type AppliedMigration = {
  version: number;
  name: string;
};

function initializeSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = database
    .prepare<[], AppliedMigration>("SELECT version, name FROM schema_migrations ORDER BY version")
    .all();

  for (const [index, migration] of applied.entries()) {
    const expected = migrations[index];
    if (!expected || migration.version !== expected.version || migration.name !== expected.name) {
      throw new Error(`Unsupported SQLite schema migration ${migration.version} (${migration.name})`);
    }
  }

  const applyMigration = database.transaction((migration: Migration) => {
    migration.up(database);
    database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.name, new Date().toISOString());
  });

  for (const migration of migrations.slice(applied.length)) {
    applyMigration.immediate(migration);
  }
}

export class StorageDatabase {
  readonly connection: Database.Database;
  readonly path: string;

  constructor(path = config.databasePath) {
    this.path = path;
    mkdirSync(dirname(path), { recursive: true });
    this.connection = new Database(path);

    try {
      this.connection.pragma("foreign_keys = ON");
      this.connection.pragma("journal_mode = WAL");
      this.connection.pragma(`busy_timeout = ${busyTimeoutMs}`);
      initializeSchema(this.connection);
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  transaction<T>(operation: (database: Database.Database) => T): T {
    return this.connection.transaction(() => operation(this.connection)).immediate();
  }

  close() {
    if (this.connection.open) {
      this.connection.close();
    }
  }
}

export function openStorageDatabase(path = config.databasePath) {
  return new StorageDatabase(path);
}
