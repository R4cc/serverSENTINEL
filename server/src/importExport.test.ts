import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ManagedNode, ManagedServer } from "./types.js";
import {
  applyImportArtifact,
  assertExportArtifact,
  createExportArtifact,
  exportArtifactSchemaVersion,
  parseExportArtifactBase64,
  validateImportArtifact,
  type ExportArtifact
} from "./importExport.js";
import { openStorageDatabase, type StorageDatabase } from "./storage/database.js";
import { ModPreferencesRepository } from "./storage/modPreferencesRepository.js";
import { NodesRepository } from "./storage/nodesRepository.js";
import { ServersRepository } from "./storage/serversRepository.js";
import { SettingsRepository } from "./storage/settingsRepository.js";

const temporaryDirectories: string[] = [];
const openDatabases: StorageDatabase[] = [];
const sourceServerId = "00000000-0000-4000-8000-000000000101";
const sourceScheduleId = "00000000-0000-4000-8000-000000000201";
const sourceRunId = "00000000-0000-4000-8000-000000000301";
const nodeId = "local";

afterEach(async () => {
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
}

function node(overrides: Partial<ManagedNode> = {}): ManagedNode {
  return {
    id: nodeId,
    name: "Local node",
    type: "local",
    status: "online",
    isInternal: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function managedServer(overrides: Partial<ManagedServer> = {}): ManagedServer {
  return {
    id: sourceServerId,
    nodeId,
    displayName: "Survival",
    serverDir: join(tmpdir(), "source-survival"),
    storageName: "source-survival",
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
    dockerContainer: "survival",
    dockerPorts: "25565:25565/tcp",
    managedPorts: [{
      id: "minecraft-server",
      name: "Minecraft Server",
      type: "minecraft",
      protocol: "tcp",
      internalPort: 25565,
      externalPort: 25565,
      required: true,
      removable: false,
      advanced: false
    }],
    javaArgs: "-Xms2G -Xmx4G",
    schedules: [{
      id: sourceScheduleId,
      name: "Restart notice",
      cron: "0 4 * * *",
      commands: ["say restart soon"],
      onlyWhenNoPlayers: false,
      enabled: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      lastRunAt: "2026-01-02T04:00:00.000Z",
      lastStatus: "success",
      lastMessage: "Sent command",
      recentRuns: [{
        id: sourceRunId,
        scheduleId: sourceScheduleId,
        scheduleName: "Restart notice",
        status: "success",
        message: "Sent command",
        ranAt: "2026-01-02T04:00:00.000Z"
      }]
    }],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function fileEntry(path: string, content: string) {
  const bytes = Buffer.from(content);
  return {
    path,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    contentBase64: bytes.toString("base64")
  };
}

function artifact(overrides: Partial<ExportArtifact> = {}): ExportArtifact {
  const base: ExportArtifact = {
    artifactType: "serversentinel.export",
    schemaVersion: exportArtifactSchemaVersion,
    manifest: {
      exportedAt: "2026-01-01T00:00:00.000Z",
      appVersion: "0.8.0",
      sqliteSchemaVersion: 7,
      content: {
        instance: true,
        servers: 1,
        serverFiles: 1
      }
    },
    instance: {
      settings: { modrinthApiKey: "modrinth-secret" },
      nodes: [node()]
    },
    servers: [{
      server: managedServer({ dockerContainer: undefined }),
      modPreferences: {
        "fabric-api.jar": {
          channel: "release",
          modrinth: {
            projectId: "fabric-api",
            versionId: "version",
            filename: "fabric-api.jar",
            versionNumber: "1.0.0",
            gameVersions: ["1.21.1"],
            loaders: ["fabric"],
            installedAt: "2026-01-01T00:00:00.000Z",
            installedWithForceIncompatible: false
          }
        }
      },
      files: [fileEntry("config/fabric-api.properties", "enabled=true\n")]
    }]
  };
  return { ...base, ...overrides };
}

async function createRepositories(root: string) {
  const storage = openStorageDatabase(join(root, "state.sqlite"));
  openDatabases.push(storage);
  const nodesRepository = new NodesRepository(storage);
  nodesRepository.create(node());
  return {
    storage,
    nodesRepository,
    serversRepository: new ServersRepository(storage, (value) => value as ManagedServer),
    modPreferencesRepository: new ModPreferencesRepository(storage),
    settingsRepository: new SettingsRepository(storage)
  };
}

describe("export/import artifacts", () => {
  it("creates a manifest with canonical server models, mod metadata, and selected config files", async () => {
    const root = await tempRoot("serversentinel-export-");
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(join(root, "server.properties"), "server-port=25565\n", "utf8");
    await writeFile(join(root, "config", "fabric-api.properties"), "enabled=true\n", "utf8");
    const server = managedServer({ serverDir: root });
    const result = await createExportArtifact({
      appVersion: "0.8.0",
      settings: { modrinthApiKey: "secret" },
      nodes: [node({ secretHash: "not-exported", joinTokenHash: "not-exported" })],
      servers: [server],
      modPreferencesForServer: () => ({ "fabric-api.jar": { channel: "release" } })
    });

    expect(result.schemaVersion).toBe(exportArtifactSchemaVersion);
    expect(result.manifest.content.servers).toBe(1);
    expect(result.servers[0].server.runtimeProfile.minecraftVersion).toBe("1.21.1");
    expect(result.servers[0].server.managedPorts?.[0]).toMatchObject({ externalPort: 25565, protocol: "tcp" });
    expect(result.servers[0].modPreferences).toEqual({ "fabric-api.jar": { channel: "release" } });
    expect(result.instance.nodes[0]).not.toHaveProperty("secretHash");
    expect(result.instance.nodes[0]).not.toHaveProperty("joinTokenHash");
    expect(result.servers[0].files.map((file) => file.path).sort()).toEqual(["config/fabric-api.properties", "server.properties"]);
  });

  it("excludes worlds, backups, logs, jars, and oversized config files by default", async () => {
    const root = await tempRoot("serversentinel-export-exclude-");
    await Promise.all([
      mkdir(join(root, "world"), { recursive: true }),
      mkdir(join(root, "backups"), { recursive: true }),
      mkdir(join(root, "logs"), { recursive: true }),
      mkdir(join(root, "config"), { recursive: true })
    ]);
    await Promise.all([
      writeFile(join(root, "server.properties"), "server-port=25565\n", "utf8"),
      writeFile(join(root, "fabric-server-launch.jar"), "jar", "utf8"),
      writeFile(join(root, "world", "level.dat"), "world", "utf8"),
      writeFile(join(root, "backups", "backup.zip"), "backup", "utf8"),
      writeFile(join(root, "logs", "latest.log"), "log", "utf8"),
      writeFile(join(root, "config", "huge.json"), "x".repeat(2 * 1024 * 1024 + 1), "utf8")
    ]);

    const result = await createExportArtifact({
      appVersion: "0.8.0",
      settings: {},
      nodes: [node()],
      servers: [managedServer({ serverDir: root })],
      modPreferencesForServer: () => ({})
    });

    expect(result.servers[0].files.map((file) => file.path)).toEqual(["server.properties"]);
  });

  it("rejects traversal paths and unsupported archive contents before validation can apply", () => {
    const valid = artifact();
    const encoded = Buffer.from(JSON.stringify(valid), "utf8").toString("base64");
    expect(parseExportArtifactBase64(encoded).servers[0].files[0].path).toBe("config/fabric-api.properties");
    expect(() => parseExportArtifactBase64("!!!!")).toThrow("valid base64");

    const traversal = structuredClone(valid);
    traversal.servers[0].files[0].path = "../server.properties";
    expect(() => assertExportArtifact(traversal)).toThrow(/stay inside|normalized/);

    const unsupported = structuredClone(valid) as ExportArtifact & { unexpected?: boolean };
    unsupported.unexpected = true;
    expect(() => assertExportArtifact(unsupported)).toThrow(/Unsupported artifact content/);

    const world = structuredClone(valid);
    world.servers[0].files[0] = fileEntry("world/level.dat", "world");
    expect(() => assertExportArtifact(world)).toThrow(/excluded|supported configuration file/);
  });

  it("rejects malformed server and mod preference payloads before planning", () => {
    const badServer = structuredClone(artifact());
    (badServer.servers[0].server as unknown as { displayName: unknown }).displayName = 42;
    expect(() => assertExportArtifact(badServer)).toThrow("displayName");

    const badPorts = structuredClone(artifact());
    badPorts.servers[0].server.dockerPorts = "25565:25565/tcp:ignored";
    expect(() => assertExportArtifact(badPorts)).toThrow("Invalid Docker port binding");

    const badPreference = structuredClone(artifact());
    badPreference.servers[0].modPreferences["fabric-api.jar"].channel = "nightly" as "release";
    expect(() => assertExportArtifact(badPreference)).toThrow("channel");

    const badFilename = structuredClone(artifact());
    badFilename.servers[0].modPreferences["../fabric-api.jar"] = badFilename.servers[0].modPreferences["fabric-api.jar"];
    expect(() => assertExportArtifact(badFilename)).toThrow("local .jar filename");
  });

  it("reports missing node targets, container conflicts, and port conflicts without writing", async () => {
    const root = await tempRoot("serversentinel-import-conflict-");
    const existing = managedServer({
      id: "00000000-0000-4000-8000-000000000909",
      displayName: "Survival",
      dockerContainer: "survival",
      serverDir: join(root, "existing")
    });
    const missingTarget = validateImportArtifact(artifact({ servers: [{ ...artifact().servers[0], server: managedServer() }] }), {
      nodes: [node()],
      existingServers: [existing],
      serversDir: join(root, "servers"),
      tmpDir: join(root, "tmp")
    });

    expect(missingTarget.valid).toBe(false);
    expect(missingTarget.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["missing_node_target", "conflicting_container_name"]));

    const withTarget = validateImportArtifact(artifact({ servers: [{ ...artifact().servers[0], server: managedServer() }] }), {
      targetNodeId: nodeId,
      nodes: [node()],
      existingServers: [existing],
      serversDir: join(root, "servers"),
      tmpDir: join(root, "tmp")
    });

    expect(withTarget.valid).toBe(false);
    expect(withTarget.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["conflicting_container_name", "conflicting_port"]));
    await expect(stat(join(root, "servers"))).rejects.toThrow();
  });

  it("applies imports with new server, schedule, and run ids without overwriting existing servers", async () => {
    const root = await tempRoot("serversentinel-import-apply-");
    const repositories = await createRepositories(root);
    const existing = managedServer({
      id: "00000000-0000-4000-8000-000000000808",
      displayName: "Survival",
      dockerContainer: "existing-survival",
      dockerPorts: "25566:25565/tcp",
      managedPorts: [{
        id: "minecraft-server",
        name: "Minecraft Server",
        type: "minecraft",
        protocol: "tcp",
        internalPort: 25565,
        externalPort: 25566,
        required: true,
        removable: false,
        advanced: false
      }]
    });
    repositories.serversRepository.create(existing);
    const importedArtifact = artifact();
    importedArtifact.servers[0].server.managedPorts![0].externalPort = 25567;
    importedArtifact.servers[0].server.dockerPorts = "25567:25565/tcp";

    const result = await applyImportArtifact(importedArtifact, {
      targetNodeId: nodeId,
      nodes: [node()],
      existingServers: repositories.serversRepository.list(),
      serversDir: join(root, "servers"),
      tmpDir: join(root, "tmp"),
      storage: repositories.storage,
      serversRepository: repositories.serversRepository,
      modPreferencesRepository: repositories.modPreferencesRepository,
      settingsRepository: repositories.settingsRepository
    });

    const importedId = result.imported[0].serverId;
    expect(importedId).not.toBe(sourceServerId);
    const servers = repositories.serversRepository.list();
    expect(servers).toHaveLength(2);
    expect(servers.find((server) => server.id === existing.id)).toBeDefined();
    const imported = servers.find((server) => server.id === importedId)!;
    expect(imported.displayName).toBe("Survival (2)");
    expect(imported.schedules?.[0].id).not.toBe(sourceScheduleId);
    expect(imported.schedules?.[0].recentRuns?.[0].id).not.toBe(sourceRunId);
    expect(imported.schedules?.[0].recentRuns?.[0].scheduleId).toBe(imported.schedules?.[0].id);
    expect(repositories.modPreferencesRepository.list(importedId)).toHaveProperty("fabric-api.jar");
    await expect(stat(join(imported.serverDir, "config", "fabric-api.properties"))).resolves.toMatchObject({ size: 13 });
  });

  it("rolls back SQLite rows and staged files when import registration fails", async () => {
    const root = await tempRoot("serversentinel-import-rollback-");
    const repositories = await createRepositories(root);
    const importedArtifact = artifact();

    await expect(applyImportArtifact(importedArtifact, {
      targetNodeId: nodeId,
      nodes: [node()],
      existingServers: repositories.serversRepository.list(),
      serversDir: join(root, "servers"),
      tmpDir: join(root, "tmp"),
      storage: repositories.storage,
      serversRepository: repositories.serversRepository,
      modPreferencesRepository: {
        replaceAll() {
          throw new Error("preference write failed");
        }
      } as ModPreferencesRepository,
      settingsRepository: repositories.settingsRepository
    })).rejects.toThrow("preference write failed");

    expect(repositories.serversRepository.list()).toEqual([]);
    expect(await readdir(join(root, "servers"))).toEqual([]);
  });
});
