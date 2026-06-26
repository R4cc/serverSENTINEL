import type Database from "better-sqlite3";
import type { ManagedServer, ManagedServerPort, ScheduledExecution, ScheduledRun } from "../types.js";
import type { StorageDatabase } from "./database.js";

type ServerRow = {
  id: string;
  node_id: string;
  display_name: string;
  server_dir: string;
  storage_name: string | null;
  runtime_profile_json: string;
  docker_container: string | null;
  docker_image: string | null;
  docker_mount_source: string | null;
  docker_working_dir: string | null;
  docker_ports: string | null;
  java_args: string | null;
  restart_required_since: string | null;
  created_at: string;
  updated_at: string;
};

type PortRow = {
  server_id: string;
  id: string;
  name: string;
  type: string;
  protocol: string;
  internal_port: number;
  external_port: number;
  required: number;
  removable: number;
  advanced: number;
};

type ScheduleRow = {
  server_id: string;
  id: string;
  name: string;
  cron: string;
  commands_json: string;
  only_when_no_players: number;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_run_at: string | null;
  last_status: string | null;
  last_message: string | null;
};

type RunRow = {
  id: string;
  server_id: string;
  schedule_id: string;
  schedule_name: string;
  status: string;
  message: string | null;
  ran_at: string;
};

function portFromRow(row: PortRow): ManagedServerPort {
  return {
    id: row.id,
    name: row.name,
    type: row.type as ManagedServerPort["type"],
    protocol: row.protocol as ManagedServerPort["protocol"],
    internalPort: row.internal_port,
    externalPort: row.external_port,
    required: row.required === 1,
    removable: row.removable === 1,
    advanced: row.advanced === 1
  };
}

function runFromRow(row: RunRow): ScheduledRun {
  return {
    id: row.id,
    scheduleId: row.schedule_id,
    scheduleName: row.schedule_name,
    status: row.status,
    message: row.message ?? undefined,
    ranAt: row.ran_at
  };
}

function scheduleFromRow(row: ScheduleRow, runs: ScheduledRun[]): ScheduledExecution {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    commands: JSON.parse(row.commands_json) as string[],
    onlyWhenNoPlayers: row.only_when_no_players === 1,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at ?? undefined,
    lastStatus: row.last_status ?? undefined,
    lastMessage: row.last_message ?? undefined,
    recentRuns: runs
  };
}

function equal(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class ServersRepository {
  constructor(
    private readonly storage: StorageDatabase,
    private readonly normalize: (value: unknown) => ManagedServer
  ) {}

  list(): ManagedServer[] {
    const database = this.storage.connection;
    const portsByServer = new Map<string, ManagedServerPort[]>();
    for (const row of database.prepare<[], PortRow>("SELECT * FROM managed_ports ORDER BY rowid").all()) {
      const ports = portsByServer.get(row.server_id) ?? [];
      ports.push(portFromRow(row));
      portsByServer.set(row.server_id, ports);
    }

    const runsBySchedule = new Map<string, ScheduledRun[]>();
    for (const row of database.prepare<[], RunRow>(`
      SELECT id, server_id, schedule_id, schedule_name, status, message, ran_at
      FROM scheduled_runs ORDER BY ran_at DESC, id DESC
    `).all()) {
      const key = `${row.server_id}:${row.schedule_id}`;
      const runs = runsBySchedule.get(key) ?? [];
      if (runs.length < 25) runs.push(runFromRow(row));
      runsBySchedule.set(key, runs);
    }

    const schedulesByServer = new Map<string, ScheduledExecution[]>();
    for (const row of database.prepare<[], ScheduleRow>("SELECT * FROM schedules ORDER BY rowid").all()) {
      const schedules = schedulesByServer.get(row.server_id) ?? [];
      schedules.push(scheduleFromRow(row, runsBySchedule.get(`${row.server_id}:${row.id}`) ?? []));
      schedulesByServer.set(row.server_id, schedules);
    }

    return database.prepare<[], ServerRow>("SELECT * FROM servers ORDER BY created_at, id").all().map((row) => this.normalize({
      id: row.id,
      nodeId: row.node_id,
      displayName: row.display_name,
      serverDir: row.server_dir,
      storageName: row.storage_name ?? undefined,
      runtimeProfile: JSON.parse(row.runtime_profile_json) as unknown,
      dockerContainer: row.docker_container ?? undefined,
      dockerImage: row.docker_image ?? undefined,
      dockerMountSource: row.docker_mount_source ?? undefined,
      dockerWorkingDir: row.docker_working_dir ?? undefined,
      dockerPorts: row.docker_ports ?? undefined,
      managedPorts: portsByServer.get(row.id) ?? [],
      javaArgs: row.java_args ?? undefined,
      restartRequiredSince: row.restart_required_since ?? undefined,
      schedules: schedulesByServer.get(row.id) ?? [],
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  create(value: ManagedServer) {
    this.storage.transaction((database) => {
      const server = this.normalize(value);
      if (database.prepare<[string]>("SELECT 1 FROM servers WHERE id = ?").get(server.id)) {
        throw new Error("A managed server with this id already exists");
      }
      this.upsertServer(database, server);
      this.syncPorts(database, server);
      this.syncSchedules(database, server);
    });
  }

  replaceMetadata(value: ManagedServer) {
    this.storage.transaction((database) => {
      const server = this.normalize(value);
      if (!database.prepare<[string]>("SELECT 1 FROM servers WHERE id = ?").get(server.id)) throw new Error("Server not found");
      this.upsertServer(database, server, { preserveRestartRequired: true });
      this.syncPorts(database, server);
    });
  }

  delete(id: string) {
    return this.storage.connection.prepare("DELETE FROM servers WHERE id = ?").run(id).changes > 0;
  }

  markRestartRequired(serverId: string, now = new Date().toISOString()) {
    return this.storage.connection.prepare(`
      UPDATE servers
      SET restart_required_since = ?, updated_at = ?
      WHERE id = ? AND restart_required_since IS NULL
    `).run(now, now, serverId).changes > 0;
  }

  clearRestartRequired(serverId: string, now = new Date().toISOString()) {
    return this.storage.connection.prepare(`
      UPDATE servers
      SET restart_required_since = NULL, updated_at = ?
      WHERE id = ? AND restart_required_since IS NOT NULL
    `).run(now, serverId).changes > 0;
  }

  createSchedule(serverId: string, schedule: ScheduledExecution, serverUpdatedAt: string) {
    this.storage.transaction((database) => {
      this.writeSchedule(database, serverId, schedule, false);
      database.prepare("UPDATE servers SET updated_at = ? WHERE id = ?").run(serverUpdatedAt, serverId);
    });
  }

  updateSchedule(serverId: string, schedule: ScheduledExecution, serverUpdatedAt: string) {
    this.storage.transaction((database) => {
      this.writeSchedule(database, serverId, schedule, true);
      database.prepare("UPDATE servers SET updated_at = ? WHERE id = ?").run(serverUpdatedAt, serverId);
    });
  }

  deleteSchedule(serverId: string, scheduleId: string, serverUpdatedAt: string) {
    this.storage.transaction((database) => {
      database.prepare("DELETE FROM schedules WHERE server_id = ? AND id = ?").run(serverId, scheduleId);
      database.prepare("UPDATE servers SET updated_at = ? WHERE id = ?").run(serverUpdatedAt, serverId);
    });
  }

  recordScheduledRun(serverId: string, scheduleId: string, run: ScheduledRun) {
    this.storage.transaction((database) => {
      const updated = database.prepare(`
        UPDATE schedules SET last_run_at = ?, last_status = ?, last_message = ?, updated_at = ?
        WHERE server_id = ? AND id = ?
      `).run(run.ranAt, run.status, run.message ?? null, run.ranAt, serverId, scheduleId);
      if (updated.changes === 0) return;
      database.prepare(`
        INSERT INTO scheduled_runs (id, server_id, schedule_id, schedule_name, status, message, ran_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(run.id, serverId, scheduleId, run.scheduleName, run.status, run.message ?? null, run.ranAt);
      database.prepare(`
        DELETE FROM scheduled_runs
        WHERE server_id = ? AND schedule_id = ? AND id NOT IN (
          SELECT id FROM scheduled_runs WHERE server_id = ? AND schedule_id = ?
          ORDER BY ran_at DESC, id DESC LIMIT 25
        )
      `).run(serverId, scheduleId, serverId, scheduleId);
    });
  }

  private writeSchedule(database: Database.Database, serverId: string, schedule: ScheduledExecution, update: boolean) {
    const statement = update
      ? database.prepare(`
        UPDATE schedules SET name=?, cron=?, commands_json=?, only_when_no_players=?, enabled=?,
          created_at=?, updated_at=? WHERE server_id=? AND id=?
      `)
      : database.prepare(`
        INSERT INTO schedules (
          name, cron, commands_json, only_when_no_players, enabled, created_at, updated_at, server_id, id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    const result = statement.run(
      schedule.name, schedule.cron, JSON.stringify(schedule.commands), schedule.onlyWhenNoPlayers ? 1 : 0,
      schedule.enabled ? 1 : 0, schedule.createdAt, schedule.updatedAt, serverId, schedule.id
    );
    if (update && result.changes === 0) throw new Error("Schedule not found");
  }

  private upsertServer(database: Database.Database, server: ManagedServer, options: { preserveRestartRequired?: boolean } = {}) {
    const statement = options.preserveRestartRequired
      ? database.prepare(`
        INSERT INTO servers (
          id, node_id, display_name, server_dir, storage_name, runtime_profile_json,
          docker_container, docker_image, docker_mount_source, docker_working_dir,
          docker_ports, java_args, restart_required_since, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          node_id=excluded.node_id, display_name=excluded.display_name,
          server_dir=excluded.server_dir, storage_name=excluded.storage_name,
          runtime_profile_json=excluded.runtime_profile_json,
          docker_container=excluded.docker_container, docker_image=excluded.docker_image,
          docker_mount_source=excluded.docker_mount_source,
          docker_working_dir=excluded.docker_working_dir, docker_ports=excluded.docker_ports,
          java_args=excluded.java_args, restart_required_since=servers.restart_required_since,
          created_at=excluded.created_at, updated_at=excluded.updated_at
      `)
      : database.prepare(`
        INSERT INTO servers (
          id, node_id, display_name, server_dir, storage_name, runtime_profile_json,
          docker_container, docker_image, docker_mount_source, docker_working_dir,
          docker_ports, java_args, restart_required_since, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          node_id=excluded.node_id, display_name=excluded.display_name,
          server_dir=excluded.server_dir, storage_name=excluded.storage_name,
          runtime_profile_json=excluded.runtime_profile_json,
          docker_container=excluded.docker_container, docker_image=excluded.docker_image,
          docker_mount_source=excluded.docker_mount_source,
          docker_working_dir=excluded.docker_working_dir, docker_ports=excluded.docker_ports,
          java_args=excluded.java_args, restart_required_since=excluded.restart_required_since,
          created_at=excluded.created_at, updated_at=excluded.updated_at
      `);
    statement.run(
      server.id, server.nodeId, server.displayName, server.serverDir, server.storageName ?? null,
      JSON.stringify(server.runtimeProfile), server.dockerContainer ?? null,
      server.dockerImage ?? null, server.dockerMountSource ?? null, server.dockerWorkingDir ?? null,
      server.dockerPorts ?? null, server.javaArgs ?? null, server.restartRequiredSince ?? null, server.createdAt, server.updatedAt
    );
  }

  private syncPorts(database: Database.Database, server: ManagedServer) {
    database.prepare("DELETE FROM managed_ports WHERE server_id = ?").run(server.id);
    const insert = database.prepare(`
      INSERT INTO managed_ports (
        server_id, node_id, id, name, type, protocol, internal_port, external_port,
        required, removable, advanced
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const port of server.managedPorts ?? []) {
      insert.run(
        server.id, server.nodeId, port.id, port.name, port.type, port.protocol,
        port.internalPort, port.externalPort, port.required ? 1 : 0,
        port.removable ? 1 : 0, port.advanced ? 1 : 0
      );
    }
  }

  private syncSchedules(database: Database.Database, server: ManagedServer) {
    const upsert = database.prepare(`
      INSERT INTO schedules (
        server_id, id, name, cron, commands_json, only_when_no_players, enabled,
        created_at, updated_at, last_run_at, last_status, last_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id, id) DO UPDATE SET
        name=excluded.name, cron=excluded.cron, commands_json=excluded.commands_json,
        only_when_no_players=excluded.only_when_no_players, enabled=excluded.enabled,
        created_at=excluded.created_at, updated_at=excluded.updated_at,
        last_run_at=excluded.last_run_at, last_status=excluded.last_status,
        last_message=excluded.last_message
    `);
    for (const schedule of server.schedules ?? []) {
      upsert.run(
        server.id, schedule.id, schedule.name, schedule.cron, JSON.stringify(schedule.commands),
        schedule.onlyWhenNoPlayers ? 1 : 0, schedule.enabled ? 1 : 0, schedule.createdAt,
        schedule.updatedAt, schedule.lastRunAt ?? null, schedule.lastStatus ?? null,
        schedule.lastMessage ?? null
      );
      this.syncRuns(database, server.id, schedule);
    }
  }

  private syncRuns(database: Database.Database, serverId: string, schedule: ScheduledExecution) {
    const runs = schedule.recentRuns ?? [];
    const keepIds = new Set(runs.map((run) => run.id));
    const existing = database.prepare<[string, string], RunRow>(
      "SELECT id, server_id, schedule_id, schedule_name, status, message, ran_at FROM scheduled_runs WHERE server_id = ? AND schedule_id = ?"
    ).all(serverId, schedule.id);
    const existingById = new Map(existing.map((row) => [row.id, runFromRow(row)]));
    const remove = database.prepare("DELETE FROM scheduled_runs WHERE id = ?");
    for (const row of existing) if (!keepIds.has(row.id)) remove.run(row.id);
    const upsert = database.prepare(`
      INSERT INTO scheduled_runs (id, server_id, schedule_id, schedule_name, status, message, ran_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET schedule_name=excluded.schedule_name,
        status=excluded.status, message=excluded.message, ran_at=excluded.ran_at
    `);
    for (const run of runs) {
      if (!equal(existingById.get(run.id), run)) {
        upsert.run(run.id, serverId, schedule.id, run.scheduleName, run.status, run.message ?? null, run.ranAt);
      }
    }
  }
}
