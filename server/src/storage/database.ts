import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";

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
  },
  {
    version: 2,
    name: "users-nodes-settings-sessions",
    up(database) {
      database.exec(`
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT NOT NULL COLLATE NOCASE UNIQUE,
          password_hash TEXT NOT NULL,
          salt TEXT NOT NULL,
          role_preset TEXT NOT NULL,
          permissions_json TEXT NOT NULL,
          server_access_json TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL
        );
        CREATE INDEX sessions_user_id_idx ON sessions(user_id);

        CREATE TABLE nodes (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          status TEXT NOT NULL,
          is_internal INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_seen_at TEXT,
          connected_at TEXT,
          agent_version TEXT,
          protocol_version TEXT,
          capabilities_json TEXT,
          docker_status TEXT,
          data_path_status TEXT,
          total_memory INTEGER,
          compatibility TEXT,
          secret_hash TEXT,
          join_token_hash TEXT,
          join_token_expires_at TEXT
        );

        CREATE TABLE app_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          modrinth_api_key TEXT
        );
      `);
    }
  },
  {
    version: 3,
    name: "managed-servers-schedules",
    up(database) {
      database.exec(`
        CREATE TABLE servers (
          id TEXT PRIMARY KEY,
          node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
          display_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
          server_dir TEXT NOT NULL,
          storage_name TEXT,
          minecraft_version TEXT,
          loader_version TEXT,
          installer_version TEXT,
          server_jar TEXT,
          runtime_profile_json TEXT NOT NULL,
          docker_container TEXT,
          docker_image TEXT,
          docker_mount_source TEXT,
          docker_working_dir TEXT,
          docker_ports TEXT,
          java_args TEXT,
          server_type TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX servers_node_id_idx ON servers(node_id);

        CREATE TABLE managed_ports (
          server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
          id TEXT NOT NULL,
          name TEXT NOT NULL,
          type TEXT NOT NULL,
          protocol TEXT NOT NULL,
          internal_port INTEGER NOT NULL,
          external_port INTEGER NOT NULL,
          required INTEGER NOT NULL,
          removable INTEGER NOT NULL,
          advanced INTEGER NOT NULL,
          PRIMARY KEY (server_id, id),
          UNIQUE (node_id, external_port, protocol)
        );
        CREATE INDEX managed_ports_server_id_idx ON managed_ports(server_id);

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
          PRIMARY KEY (server_id, id)
        );
        CREATE INDEX schedules_enabled_idx ON schedules(enabled);

        CREATE TABLE scheduled_runs (
          id TEXT PRIMARY KEY,
          server_id TEXT NOT NULL,
          schedule_id TEXT NOT NULL,
          schedule_name TEXT NOT NULL,
          status TEXT NOT NULL,
          message TEXT,
          ran_at TEXT NOT NULL,
          FOREIGN KEY (server_id, schedule_id) REFERENCES schedules(server_id, id) ON DELETE CASCADE
        );
        CREATE INDEX scheduled_runs_schedule_idx ON scheduled_runs(server_id, schedule_id, ran_at DESC);
      `);
    }
  },
  {
    version: 4,
    name: "file-edit-leases",
    up(database) {
      database.exec(`
        CREATE TABLE file_edit_leases (
          lease_id TEXT PRIMARY KEY,
          server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          path TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
          display_name TEXT NOT NULL,
          acquired_at INTEGER NOT NULL,
          refreshed_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          file_revision TEXT NOT NULL,
          UNIQUE (server_id, path)
        );
        CREATE INDEX file_edit_leases_expiry_idx ON file_edit_leases(expires_at);
      `);
    }
  },
  {
    version: 5,
    name: "resource-stats-history",
    up(database) {
      database.exec(`
        CREATE TABLE resource_stats (
          server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          sampled_at INTEGER NOT NULL,
          sample_json TEXT NOT NULL,
          PRIMARY KEY (server_id, sampled_at)
        );
        CREATE INDEX resource_stats_sampled_at_idx ON resource_stats(sampled_at);
      `);
    }
  },
  {
    version: 6,
    name: "mod-preferences",
    up(database) {
      database.exec(`
        CREATE TABLE mod_preferences (
          server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
          filename TEXT NOT NULL,
          channel TEXT NOT NULL,
          metadata_json TEXT,
          PRIMARY KEY (server_id, filename)
        );
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
      this.connection.pragma("busy_timeout = 5000");
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
