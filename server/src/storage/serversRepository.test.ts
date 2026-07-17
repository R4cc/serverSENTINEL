import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedNode, ManagedServer } from "../types.js";
import { openStorageDatabase, type StorageDatabase } from "./database.js";
import { NodesRepository } from "./nodesRepository.js";
import { ServersRepository } from "./serversRepository.js";
import { ResourceStatsRepository } from "./resourceStatsRepository.js";
import { ModPreferencesRepository } from "./modPreferencesRepository.js";
import { defaultServerContainerName, serverStorageName } from "./serverIdentity.js";

const temporaryDirectories: string[] = [];
const openDatabases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createRepositories() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-servers-repository-"));
  temporaryDirectories.push(root);
  const storage = openStorageDatabase(join(root, "state.sqlite"));
  openDatabases.push(storage);
  const nodes = new NodesRepository(storage);
  const node: ManagedNode = {
    id: "node-id",
    name: "Node",
    type: "remote",
    status: "online",
    isInternal: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
  nodes.create(node);
  return {
    storage,
    nodes,
    servers: new ServersRepository(storage, (value) => value as ManagedServer)
  };
}

function managedServer(id = "server-id", externalPort = 25_565): ManagedServer {
  return {
    id,
    nodeId: "node-id",
    displayName: `Server ${id}`,
    serverDir: `/data/servers/${id}`,
    storageName: serverStorageName(id),
    runtimeProfile: {
      minecraftVersion: "1.21.1",
      loader: "fabric",
      loaderVersion: "0.16.0",
      javaMajorVersion: 21,
      jarProvider: "mcjars",
      jarArtifact: { filename: "fabric-server-launch.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: "2026-01-01T00:00:00.000Z"
    },
    dockerContainer: defaultServerContainerName(id),
    dockerPorts: `${externalPort}:25565/tcp;25575:25575/udp`,
    managedPorts: [
      {
        id: "minecraft-tcp",
        name: "Minecraft",
        type: "minecraft",
        protocol: "tcp",
        internalPort: 25_565,
        externalPort,
        required: true,
        removable: false,
        advanced: false
      },
      {
        id: "query-udp",
        name: "Query",
        type: "query",
        protocol: "udp",
        internalPort: 25_575,
        externalPort: 25_575,
        required: true,
        removable: false,
        advanced: true
      }
    ],
    javaArgs: "-Xms2G -Xmx4G",
    startOnNodeStart: false,
    runtimeIntent: "stopped",
    crashAttemptTimestamps: [],
    schedules: [{
      id: "schedule-id",
      name: "Backup notice",
      cron: "0 * * * *",
      steps: [
        { type: "command", command: "say Backup starting", delaySeconds: 0 },
        { type: "command", command: "save-all", delaySeconds: 300 }
      ],
      onlyWhenNoPlayers: false,
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      lastRunAt: "2026-01-02T00:00:00.000Z",
      lastStatus: "success",
      lastMessage: "Sent 2 commands",
      recentRuns: [{
        id: "run-id",
        scheduleId: "schedule-id",
        scheduleName: "Backup notice",
        status: "success",
        message: "Sent 2 commands",
        ranAt: "2026-01-02T00:00:00.000Z"
      }]
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("ServersRepository", () => {
  it("marks opted-in servers to start when their node starts", async () => {
    const { servers } = await createRepositories();
    const server = managedServer();
    servers.create(server);

    expect(servers.markStartOnNodeStart(server.nodeId)).toBe(0);
    expect(servers.list()[0].runtimeIntent).toBe("stopped");

    const optedIn = { ...servers.list()[0], startOnNodeStart: true };
    servers.replaceMetadata(optedIn);
    servers.setRuntimeLifecycle(server.id, {
      runtimeIntent: "stopped",
      crashAttemptTimestamps: ["2026-01-01T00:00:00.000Z"],
      crashLoopSince: "2026-01-01T00:01:00.000Z"
    });

    expect(servers.markStartOnNodeStart(server.nodeId, "2026-01-02T00:00:00.000Z")).toBe(1);
    expect(servers.list()[0]).toMatchObject({
      startOnNodeStart: true,
      runtimeIntent: "running",
      crashAttemptTimestamps: []
    });
    expect(servers.list()[0].crashLoopSince).toBeUndefined();
  });

  it("stores server, port, schedule, and run state in normalized tables", async () => {
    const { storage, servers } = await createRepositories();
    const server = managedServer();
    expect(servers.list()).toEqual([]);

    servers.create(server);
    expect(servers.list()).toEqual([server]);
    expect(storage.connection.prepare("SELECT COUNT(*) AS count FROM managed_ports").get()).toEqual({ count: 2 });
    expect(storage.connection.prepare("SELECT COUNT(*) AS count FROM schedules").get()).toEqual({ count: 1 });
    expect(storage.connection.prepare("SELECT COUNT(*) AS count FROM scheduled_runs").get()).toEqual({ count: 1 });

    const updated = structuredClone(server);
    updated.javaArgs = "-Xms4G -Xmx4G";
    updated.schedules![0].recentRuns = [{
      id: "new-run-id",
      scheduleId: "schedule-id",
      scheduleName: "Backup notice",
      status: "skipped",
      ranAt: "2026-01-03T00:00:00.000Z"
    }, ...updated.schedules![0].recentRuns!];
    updated.schedules![0].lastRunAt = "2026-01-03T00:00:00.000Z";
    updated.schedules![0].lastStatus = "skipped";
    updated.schedules![0].lastMessage = "Skipped run";
    updated.schedules![0].updatedAt = "2026-01-03T00:00:00.000Z";
    updated.schedules![0].recentRuns![0].message = "Skipped run";
    servers.replaceMetadata(updated);
    servers.recordScheduledRun(updated.id, updated.schedules![0].id, updated.schedules![0].recentRuns![0]);

    expect(servers.list()).toEqual([updated]);
    expect(storage.connection.prepare("SELECT COUNT(*) AS count FROM scheduled_runs").get()).toEqual({ count: 2 });
  });

  it("round-trips mixed command and action steps with run details", async () => {
    const { servers } = await createRepositories();
    const server = managedServer();
    const schedule = server.schedules![0];
    schedule.steps = [
      { type: "command", command: "say restarting", delaySeconds: 0 },
      { type: "action", procedure: "restart", delaySeconds: 300 }
    ];
    schedule.recentRuns![0].details = {
      stepCount: 2,
      completedStepCount: 2,
      terminalStepIndex: 1,
      terminalStep: "Restart",
      steps: [{
        stepIndex: 0,
        type: "command",
        command: "say restarting",
        delaySeconds: 0,
        status: "success",
        startedAt: "2026-01-02T00:00:00.000Z",
        completedAt: "2026-01-02T00:00:01.000Z",
        logs: ["[Server thread/INFO]: [Server] restarting"],
        logCaptureStatus: "captured"
      }, {
        stepIndex: 1,
        type: "action",
        procedure: "restart",
        delaySeconds: 300,
        status: "success",
        startedAt: "2026-01-02T00:05:00.000Z",
        completedAt: "2026-01-02T00:05:10.000Z"
      }]
    };

    servers.create(server);

    expect(servers.list()[0].schedules![0]).toMatchObject({
      steps: schedule.steps,
      recentRuns: [{ details: schedule.recentRuns![0].details }]
    });
  });

  it("enforces per-node port uniqueness transactionally", async () => {
    const { servers } = await createRepositories();
    const first = managedServer();
    servers.create(first);

    expect(() => servers.create(managedServer("second-id"))).toThrow(/UNIQUE constraint failed/);
    expect(servers.list()).toEqual([first]);
  });

  it("records schedule runs without overwriting a concurrent schedule edit", async () => {
    const { servers } = await createRepositories();
    const server = managedServer();
    servers.create(server);
    const edited = {
      ...server.schedules![0],
      name: "Renamed schedule",
      cron: "30 * * * *",
      updatedAt: "2026-01-04T00:00:00.000Z"
    };
    servers.updateSchedule(server.id, edited, edited.updatedAt);

    servers.recordScheduledRun(server.id, edited.id, {
      id: "concurrent-run",
      scheduleId: edited.id,
      scheduleName: "Backup notice",
      status: "success",
      message: "Sent 1 command",
      ranAt: "2026-01-04T00:01:00.000Z"
    });

    const schedule = servers.list()[0].schedules![0];
    expect(schedule.name).toBe("Renamed schedule");
    expect(schedule.cron).toBe("30 * * * *");
    expect(schedule.lastRunAt).toBe("2026-01-04T00:01:00.000Z");
    expect(schedule.recentRuns?.[0].id).toBe("concurrent-run");
  });

  it("marks, preserves, and clears restart-required state idempotently", async () => {
    const { storage, servers } = await createRepositories();
    const server = managedServer();
    servers.create(server);

    expect(servers.markRestartRequired(server.id, "2026-01-02T00:00:00.000Z")).toBe(true);
    expect(servers.markRestartRequired(server.id, "2026-01-03T00:00:00.000Z")).toBe(false);

    const marked = servers.list()[0];
    expect(marked.restartRequiredSince).toBe("2026-01-02T00:00:00.000Z");
    expect(marked.updatedAt).toBe("2026-01-02T00:00:00.000Z");

    servers.replaceMetadata({ ...marked, displayName: "Renamed", updatedAt: "2026-01-04T00:00:00.000Z" });
    expect(servers.list()[0]).toMatchObject({
      displayName: "Renamed",
      restartRequiredSince: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-04T00:00:00.000Z"
    });

    expect(servers.clearRestartRequired(server.id, "2026-01-05T00:00:00.000Z")).toBe(true);
    expect(servers.clearRestartRequired(server.id, "2026-01-06T00:00:00.000Z")).toBe(false);
    expect(servers.list()[0].restartRequiredSince).toBeUndefined();
    expect(storage.connection.prepare("SELECT updated_at FROM servers WHERE id = ?").get(server.id)).toEqual({ updated_at: "2026-01-05T00:00:00.000Z" });
  });

  it("persists and clears pending mod restart details", async () => {
    const { servers } = await createRepositories();
    const server = managedServer();
    servers.create(server);
    const baseline = [{ identity: "file:example.jar", displayName: "example.jar", filename: "example.jar", enabled: true, sha1: "before" }];
    expect(servers.beginModRestartTracking(server.id, baseline, "2026-01-02T00:00:00.000Z")).toBe(true);
    servers.updateModRestartChanges(server.id, [{ type: "mod", identity: "file:example.jar", displayName: "example.jar", filename: "example.jar.disabled", action: "disabled" }], "2026-01-03T00:00:00.000Z");
    expect(servers.list()[0]).toMatchObject({
      restartRequiredSince: "2026-01-02T00:00:00.000Z",
      restartRequiredModBaseline: baseline,
      restartRequiredChanges: [{ action: "disabled", displayName: "example.jar" }]
    });
    servers.updateModRestartChanges(server.id, [], "2026-01-04T00:00:00.000Z");
    expect(servers.list()[0].restartRequiredSince).toBeUndefined();
    expect(servers.list()[0].restartRequiredChanges).toBeUndefined();
    expect(servers.list()[0].restartRequiredModBaseline).toBeUndefined();
  });

  it("defaults, updates, and preserves runtime intent", async () => {
    const { servers } = await createRepositories();
    const server = { ...managedServer(), runtimeIntent: undefined };
    servers.create(server);

    expect(servers.list()[0].runtimeIntent).toBe("stopped");
    expect(servers.setRuntimeIntent(server.id, "running", "2026-01-02T00:00:00.000Z")).toBe(true);
    expect(servers.setRuntimeIntent(server.id, "running", "2026-01-03T00:00:00.000Z")).toBe(false);

    const running = servers.list()[0];
    servers.replaceMetadata({ ...running, displayName: "Renamed", runtimeIntent: "stopped" });
    expect(servers.list()[0]).toMatchObject({ displayName: "Renamed", runtimeIntent: "running" });
  });

  it("persists restart phases and crash-loop recovery metadata", async () => {
    const { servers } = await createRepositories();
    const server = managedServer();
    servers.create(server);

    servers.setRuntimeLifecycle(server.id, {
      runtimeIntent: "restarting",
      restartPhase: "starting",
      crashAttemptTimestamps: ["2026-01-02T00:00:00.000Z"],
      crashNextRetryAt: "2026-01-02T00:00:15.000Z",
      crashLoopSince: undefined,
      crashStableSince: undefined
    });

    expect(servers.list()[0]).toMatchObject({
      runtimeIntent: "restarting",
      restartPhase: "starting",
      crashAttemptTimestamps: ["2026-01-02T00:00:00.000Z"],
      crashNextRetryAt: "2026-01-02T00:00:15.000Z"
    });
  });

  it("retains every scheduled run from the last 24 hours plus at least the newest 25", async () => {
    const { storage, servers } = await createRepositories();
    const server = managedServer();
    servers.create(server);
    storage.connection.prepare("DELETE FROM scheduled_runs WHERE server_id = ?").run(server.id);
    const start = new Date("2026-01-01T00:00:00.000Z").getTime();
    for (let index = 0; index < 30; index += 1) {
      servers.recordScheduledRun(server.id, "schedule-id", {
        id: `dense-${index}`,
        scheduleId: "schedule-id",
        scheduleName: "Backup notice",
        status: "success",
        ranAt: new Date(start + index * 60_000).toISOString()
      });
    }
    expect(storage.connection.prepare("SELECT COUNT(*) AS count FROM scheduled_runs").get()).toEqual({ count: 30 });
    expect(servers.scheduledRunsInRange(server.id, start, start + 60 * 60_000)).toHaveLength(30);

    servers.recordScheduledRun(server.id, "schedule-id", {
      id: "two-days-later",
      scheduleId: "schedule-id",
      scheduleName: "Backup notice",
      status: "success",
      ranAt: new Date(start + 48 * 60 * 60_000).toISOString()
    });
    expect(storage.connection.prepare("SELECT COUNT(*) AS count FROM scheduled_runs").get()).toEqual({ count: 25 });
  });

  it("renames display names without changing immutable identity or dependent state", async () => {
    const { storage, servers } = await createRepositories();
    const original = managedServer("00000000-0000-4000-8000-000000000001");
    servers.create(original);
    new ResourceStatsRepository(storage).append(original.id, {
      available: true,
      running: true,
      cpuPercent: 1,
      memoryUsageBytes: 2,
      memoryLimitBytes: 3,
      readAt: "2026-01-01T00:00:00.000Z",
      sampledAt: 1
    }, 0);
    const modPreferences = new ModPreferencesRepository(storage);
    modPreferences.replaceAll(original.id, { "fabric-api.jar": { channel: "release" } });

    const renamed = {
      ...original,
      displayName: "Renamed Survival",
      updatedAt: "2026-01-05T00:00:00.000Z"
    };
    servers.replaceMetadata(renamed);

    expect(servers.list()).toEqual([renamed]);
    expect(servers.list()[0]).toMatchObject({
      id: original.id,
      serverDir: original.serverDir,
      storageName: original.storageName,
      dockerContainer: original.dockerContainer
    });
    expect(servers.list()[0].schedules?.[0].id).toBe(original.schedules![0].id);
    expect(storage.connection.prepare("SELECT COUNT(*) AS count FROM resource_stats WHERE server_id = ?").get(original.id)).toEqual({ count: 1 });
    expect(modPreferences.list(original.id)).toEqual({ "fabric-api.jar": { channel: "release" } });
  });

  it("cascades dependent ports, schedules, and runs when deleting a server", async () => {
    const { storage, servers } = await createRepositories();
    servers.create(managedServer());
    new ResourceStatsRepository(storage).append("server-id", {
      available: true,
      running: true,
      cpuPercent: 1,
      memoryUsageBytes: 2,
      memoryLimitBytes: 3,
      readAt: "2026-01-01T00:00:00.000Z",
      sampledAt: 1
    }, 0);
    const modPreferences = new ModPreferencesRepository(storage);
    modPreferences.replaceAll("server-id", { "fabric-api.jar": { channel: "release" } });
    expect(modPreferences.list("server-id")).toEqual({ "fabric-api.jar": { channel: "release" } });
    servers.delete("server-id");

    expect(servers.list()).toEqual([]);
    for (const table of ["managed_ports", "schedules", "scheduled_runs"]) {
      expect(storage.connection.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
    }
    expect(storage.connection.prepare("SELECT COUNT(*) AS count FROM resource_stats").get()).toEqual({ count: 0 });
    expect(storage.connection.prepare("SELECT COUNT(*) AS count FROM mod_preferences").get()).toEqual({ count: 0 });
  });

  it("deletes a node and its servers in one transaction only when forced", async () => {
    const { nodes, servers } = await createRepositories();
    servers.create(managedServer());

    expect(() => nodes.deleteWithServers("node-id", false)).toThrow("Cannot delete a node while servers are assigned to it");
    expect(nodes.list()).toHaveLength(1);
    expect(servers.list()).toHaveLength(1);

    expect(nodes.deleteWithServers("node-id", true).deletedServers).toBe(1);
    expect(nodes.list()).toEqual([]);
    expect(servers.list()).toEqual([]);
  });
});
