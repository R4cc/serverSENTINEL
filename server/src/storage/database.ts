import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { config } from "../config.js";

type AppliedMigration = {
  version: number;
  name: string;
};

export const currentSchemaVersion = 18;
export const currentSchemaName = "current-schema-baseline";

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

const applicationTableNames = [
  "storage_metadata",
  "users",
  "sessions",
  "nodes",
  "app_settings",
  "servers",
  "managed_ports",
  "schedules",
  "scheduled_runs",
  "file_edit_leases",
  "resource_stats",
  "mod_preferences",
  "operations"
] as const;

const currentNodeColumns = ["id", "name", "type", "status", "is_internal", "created_at", "updated_at", "last_seen_at", "connected_at", "agent_version", "protocol_version", "capabilities_json", "docker_status", "data_path_status", "total_memory", "secret_hash", "join_token_hash", "join_token_expires_at", "build_id"];
const currentServerColumns = ["id", "node_id", "display_name", "server_dir", "storage_name", "runtime_profile_json", "docker_container", "docker_image", "docker_mount_source", "docker_working_dir", "docker_ports", "java_args", "start_on_node_start", "created_at", "updated_at", "restart_required_since", "restart_required_changes_json", "restart_required_mod_baseline_json", "runtime_intent", "restart_phase", "crash_attempts_json", "crash_next_retry_at", "crash_loop_since", "crash_stable_since"];
const schema17ServerColumns = currentServerColumns.filter((column) => column !== "start_on_node_start");
const currentScheduleColumns = ["server_id", "id", "name", "cron", "steps_json", "only_when_no_players", "enabled", "created_at", "updated_at", "last_run_at", "last_status", "last_message"];
const unchangedTableColumns: Readonly<Record<string, readonly string[]>> = {
  storage_metadata: ["key", "value"],
  users: ["id", "username", "password_hash", "salt", "role_preset", "permissions_json", "server_access_json", "created_at", "updated_at"],
  sessions: ["id", "user_id", "created_at"],
  app_settings: ["id", "modrinth_api_key"],
  managed_ports: ["server_id", "node_id", "id", "name", "type", "protocol", "internal_port", "external_port", "required", "removable", "advanced"],
  scheduled_runs: ["id", "server_id", "schedule_id", "schedule_name", "status", "message", "ran_at", "details_json"],
  file_edit_leases: ["lease_id", "server_id", "path", "user_id", "session_id", "display_name", "acquired_at", "refreshed_at", "expires_at", "file_revision"],
  resource_stats: ["server_id", "sampled_at", "sample_json"],
  mod_preferences: ["server_id", "filename", "channel", "metadata_json"],
  operations: ["id", "type", "status", "server_id", "node_id", "created_by", "progress", "task", "created_at", "started_at", "finished_at", "error_message", "result_json", "log_summary"]
};
const applicationIndexNames = ["sessions_user_id_idx", "servers_node_id_idx", "managed_ports_server_id_idx", "schedules_enabled_idx", "scheduled_runs_schedule_idx", "file_edit_leases_expiry_idx", "resource_stats_sampled_at_idx", "operations_created_at_idx", "operations_server_id_idx", "operations_status_idx"];

function createCurrentSchema(database: Database.Database) {
  database.exec(`
    CREATE TABLE storage_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;

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
      secret_hash TEXT,
      join_token_hash TEXT,
      join_token_expires_at TEXT,
      build_id TEXT
    );

    CREATE TABLE app_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      modrinth_api_key TEXT
    );

    CREATE TABLE servers (
      id TEXT PRIMARY KEY,
      node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE RESTRICT,
      display_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      server_dir TEXT NOT NULL,
      storage_name TEXT,
      runtime_profile_json TEXT NOT NULL,
      docker_container TEXT,
      docker_image TEXT,
      docker_mount_source TEXT,
      docker_working_dir TEXT,
      docker_ports TEXT,
      java_args TEXT,
      start_on_node_start INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      restart_required_since TEXT,
      restart_required_changes_json TEXT,
      restart_required_mod_baseline_json TEXT,
      runtime_intent TEXT CHECK (runtime_intent IS NULL OR runtime_intent IN ('stopped', 'running', 'restarting')),
      restart_phase TEXT CHECK (restart_phase IS NULL OR restart_phase IN ('stopping', 'starting')),
      crash_attempts_json TEXT NOT NULL DEFAULT '[]',
      crash_next_retry_at TEXT,
      crash_loop_since TEXT,
      crash_stable_since TEXT
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
      steps_json TEXT NOT NULL,
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
      details_json TEXT,
      FOREIGN KEY (server_id, schedule_id) REFERENCES schedules(server_id, id) ON DELETE CASCADE
    );
    CREATE INDEX scheduled_runs_schedule_idx ON scheduled_runs(server_id, schedule_id, ran_at DESC);

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

    CREATE TABLE resource_stats (
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      sampled_at INTEGER NOT NULL,
      sample_json TEXT NOT NULL,
      PRIMARY KEY (server_id, sampled_at)
    );
    CREATE INDEX resource_stats_sampled_at_idx ON resource_stats(sampled_at);

    CREATE TABLE mod_preferences (
      server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      channel TEXT NOT NULL,
      metadata_json TEXT,
      PRIMARY KEY (server_id, filename)
    );

    CREATE TABLE operations (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      server_id TEXT,
      node_id TEXT,
      created_by TEXT,
      progress INTEGER NOT NULL DEFAULT 0,
      task TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      error_message TEXT,
      result_json TEXT,
      log_summary TEXT
    );
    CREATE INDEX operations_created_at_idx ON operations(created_at DESC);
    CREATE INDEX operations_server_id_idx ON operations(server_id, created_at DESC);
    CREATE INDEX operations_status_idx ON operations(status, created_at DESC);
  `);
}

function migrationHistory(database: Database.Database) {
  return database.prepare<[], AppliedMigration>("SELECT version, name FROM schema_migrations ORDER BY version").all();
}

function isCurrentSchema(history: AppliedMigration[]) {
  return history.length === 1
    && history[0].version === currentSchemaVersion
    && history[0].name === currentSchemaName;
}

function isSchema17Baseline(history: AppliedMigration[]) {
  return history.length === 1
    && history[0].version === 17
    && history[0].name === currentSchemaName;
}

function isLegacySchema16(history: AppliedMigration[]) {
  return history.length === legacySchema16Migrations.length
    && history.every((migration, index) => migration.version === index + 1 && migration.name === legacySchema16Migrations[index]);
}

function applicationTables(database: Database.Database) {
  return database.prepare<[], { name: string }>(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'
  `).all();
}

function tableExists(database: Database.Database, name: string) {
  return Boolean(database.prepare<[string], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function tableColumns(database: Database.Database, name: string) {
  return database.prepare<[string], { name: string }>("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(name).map((column) => column.name);
}

function sameNames(actual: string[], expected: readonly string[]) {
  return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
}

function sameNameSet(actual: string[], expected: readonly string[]) {
  return sameNames([...actual].sort(), [...expected].sort());
}

function assertApplicationTables(database: Database.Database) {
  const actual = applicationTables(database).map((table) => table.name).sort();
  const expected = [...applicationTableNames].sort();
  if (!sameNames(actual, expected)) throw new Error("Malformed SQLite schema: application table layout does not match the supported baseline.");
  for (const [table, columns] of Object.entries(unchangedTableColumns)) {
    if (!sameNames(tableColumns(database, table), columns)) throw new Error(`Malformed SQLite schema: ${table} columns do not match the supported baseline.`);
  }
  const indexes = database.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all().map(({ name }) => name);
  if (!sameNameSet(indexes, applicationIndexNames)) throw new Error("Malformed SQLite schema: application indexes do not match the supported baseline.");
}

function assertCurrentSchemaLayout(database: Database.Database) {
  assertApplicationTables(database);
  if (!sameNameSet(tableColumns(database, "nodes"), currentNodeColumns)
    || !sameNameSet(tableColumns(database, "servers"), currentServerColumns)
    || !sameNameSet(tableColumns(database, "schedules"), currentScheduleColumns)) {
    throw new Error("Malformed SQLite schema: compact schema-18 columns do not match the supported baseline.");
  }
}

function assertSchema17Layout(database: Database.Database) {
  assertApplicationTables(database);
  if (!sameNameSet(tableColumns(database, "nodes"), currentNodeColumns)
    || !sameNameSet(tableColumns(database, "servers"), schema17ServerColumns)
    || !sameNameSet(tableColumns(database, "schedules"), currentScheduleColumns)) {
    throw new Error("Malformed SQLite schema: compact schema-17 columns do not match the supported baseline.");
  }
}

function assertLegacySchema16Layout(database: Database.Database) {
  assertApplicationTables(database);
  if (!sameNameSet(tableColumns(database, "nodes"), [...currentNodeColumns.slice(0, 15), "compatibility", ...currentNodeColumns.slice(15)])
    || !sameNameSet(tableColumns(database, "servers"), [...schema17ServerColumns.slice(0, 17), "desired_runtime_state", ...schema17ServerColumns.slice(17)])
    || !sameNameSet(tableColumns(database, "schedules"), ["server_id", "id", "name", "cron", "commands_json", "only_when_no_players", "enabled", "created_at", "updated_at", "last_run_at", "last_status", "last_message", "command_delays_json", "command_delays_seconds_json", "steps_json"])) {
    throw new Error("Malformed SQLite schema: schema-16 columns do not match the supported 1.2.1 layout.");
  }
}

function recordCurrentSchema(database: Database.Database) {
  database.prepare("DELETE FROM schema_migrations").run();
  database.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
    .run(currentSchemaVersion, currentSchemaName, new Date().toISOString());
}

function initializeSchema(database: Database.Database) {
  if (!tableExists(database, "schema_migrations")) {
    if (applicationTables(database).length !== 0) {
      throw new Error("Malformed SQLite schema: schema_migrations is missing. Restore a valid backup before starting serverSENTINEL 1.3.");
    }
    database.transaction(() => {
      database.exec(`
        CREATE TABLE schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TEXT NOT NULL
        )
      `);
      createCurrentSchema(database);
      recordCurrentSchema(database);
    }).immediate();
    return;
  }

  if (!sameNames(tableColumns(database, "schema_migrations"), ["version", "name", "applied_at"])) {
    throw new Error("Malformed SQLite schema: schema_migrations has an unsupported layout.");
  }

  const history = migrationHistory(database);
  if (isCurrentSchema(history)) {
    assertCurrentSchemaLayout(database);
    return;
  }

  if (isSchema17Baseline(history)) {
    assertSchema17Layout(database);
    database.transaction(() => {
      database.exec("ALTER TABLE servers ADD COLUMN start_on_node_start INTEGER NOT NULL DEFAULT 0;");
      recordCurrentSchema(database);
    }).immediate();
    return;
  }

  if (isLegacySchema16(history)) {
    assertLegacySchema16Layout(database);
    database.transaction(() => {
      database.exec(`
        ALTER TABLE nodes DROP COLUMN compatibility;
        ALTER TABLE schedules DROP COLUMN commands_json;
        ALTER TABLE schedules DROP COLUMN command_delays_json;
        ALTER TABLE schedules DROP COLUMN command_delays_seconds_json;
        ALTER TABLE servers DROP COLUMN desired_runtime_state;
        ALTER TABLE servers ADD COLUMN start_on_node_start INTEGER NOT NULL DEFAULT 0;
      `);
      recordCurrentSchema(database);
    }).immediate();
    return;
  }

  const version = history.at(-1)?.version;
  if (version !== undefined && version < 16) {
    throw new Error(`SQLite schema ${version} is too old for serverSENTINEL 1.3. Upgrade this data root with serverSENTINEL 1.2.1 first, then start 1.3 again.`);
  }
  if (version !== undefined && version > currentSchemaVersion) {
    throw new Error(`SQLite schema ${version} is newer than serverSENTINEL 1.3 supports. Install a matching newer release or restore a schema-16 backup.`);
  }
  throw new Error("Unsupported SQLite schema. Restore a matching backup or upgrade the data root with serverSENTINEL 1.2.1 before starting 1.3.");
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
      this.connection.pragma("busy_timeout = 5000");
      initializeSchema(this.connection);
      this.connection.pragma("journal_mode = WAL");
    } catch (error) {
      this.connection.close();
      throw error;
    }
  }

  transaction<T>(operation: (database: Database.Database) => T): T {
    return this.connection.transaction(() => operation(this.connection)).immediate();
  }

  checkpointWal(mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE") {
    if (mode === "FULL") return this.connection.pragma("wal_checkpoint(FULL)");
    if (mode === "RESTART") return this.connection.pragma("wal_checkpoint(RESTART)");
    if (mode === "TRUNCATE") return this.connection.pragma("wal_checkpoint(TRUNCATE)");
    return this.connection.pragma("wal_checkpoint(PASSIVE)");
  }

  async backupTo(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    return this.connection.backup(path);
  }

  metadata(key: string) {
    const row = this.connection.prepare<[string], { value: string }>("SELECT value FROM storage_metadata WHERE key = ?").get(key);
    return row?.value;
  }

  setMetadata(key: string, value: string) {
    this.connection.prepare(`
      INSERT INTO storage_metadata (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  close() {
    if (this.connection.open) {
      this.checkpointWal("PASSIVE");
      this.connection.close();
    }
  }
}

export function openStorageDatabase(path = config.databasePath) {
  return new StorageDatabase(path);
}
