import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXPORT_SCHEMA_VERSION, type ExportSelection } from "@serversentinel/contracts";
import type { ManagedServer } from "./types.js";
import {
  applyImportArchive,
  assertExportManifest,
  createExportPlan,
  exportArchiveCompressionLevel,
  readExportManifest,
  serverArchiveKey,
  validateImportArchive,
  writeDownloadedExportArchive,
  writeExportArchive,
  type ExportManifest
} from "./importExport.js";
import type { NodeRuntime } from "./nodes/types.js";
import { openStorageDatabase, type StorageDatabase } from "./storage/database.js";
import { ModPreferencesRepository } from "./storage/modPreferencesRepository.js";
import { NodesRepository } from "./storage/nodesRepository.js";
import { ServersRepository } from "./storage/serversRepository.js";
import { SettingsRepository } from "./storage/settingsRepository.js";

/**
 * Models a deployment where the servers directory is its own mount -- a big disk for worlds, which
 * is how anyone with a large world sets this up. `rename` cannot cross a device boundary there, so
 * only a move from one root to the other fails; renames within a directory still work, which is
 * what archive extraction does while it stages the files.
 */
const deviceBoundary = vi.hoisted(() => ({ from: "", to: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    default: actual,
    rename: async (source: string, destination: string) => {
      if (deviceBoundary.from && String(source).startsWith(deviceBoundary.from) && String(destination).startsWith(deviceBoundary.to)) {
        throw Object.assign(
          new Error(`EXDEV: cross-device link not permitted, rename '${source}' -> '${destination}'`),
          { code: "EXDEV" }
        );
      }
      return actual.rename(source, destination);
    }
  };
});

const temporaryDirectories: string[] = [];
const openDatabases: StorageDatabase[] = [];
const sourceServerId = "00000000-0000-4000-8000-000000000101";
const sourceScheduleId = "00000000-0000-4000-8000-000000000201";
const sourceRunId = "00000000-0000-4000-8000-000000000301";
const nodeId = "local";

const everything: ExportSelection = {
  categories: ["serverConfig", "accessControl", "modConfig", "content", "world", "panelSettings", "logs"],
  contentStrategy: "jars"
};

afterEach(async () => {
  deviceBoundary.from = "";
  deviceBoundary.to = "";
  for (const database of openDatabases.splice(0)) database.close();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function tempRoot(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(root);
  return root;
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
      runtimeType: "fabric",
      runtimeVersion: "0.16.0",
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
      steps: [
        { type: "command", command: "say restart soon", delaySeconds: 0 },
        { type: "command", command: "stop", delaySeconds: 300 }
      ],
      onlyWhenNoPlayers: false,
      waitForPlayersToLeave: false,
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

/**
 * Export reads exclusively through the runtime abstraction, so a directory-backed fake exercises the
 * same path a remote node would take without needing a node agent.
 */
function directoryRuntime(): NodeRuntime {
  const publicToAbsolute = (server: ManagedServer, path: string) => {
    const trimmed = path.replace(/^\/+/, "");
    const absolute = trimmed ? resolve(server.serverDir, trimmed) : resolve(server.serverDir);
    const contained = relative(resolve(server.serverDir), absolute);
    if (contained.startsWith("..") || contained.split(sep).includes("..")) {
      throw new Error("path escapes the server directory");
    }
    return absolute;
  };
  return {
    nodeId,
    async resolveExistingPath(server: ManagedServer, path: string) {
      const absolute = publicToAbsolute(server, path);
      await stat(absolute);
      return absolute;
    },
    async listFiles(server: ManagedServer, target: string) {
      const entries = await readdir(target as string, { withFileTypes: true });
      const root = resolve(server.serverDir);
      const publicPath = (absolute: string) => `/${relative(root, absolute).split(sep).join("/")}`;
      return {
        path: publicPath(target as string),
        entries: await Promise.all(entries.map(async (entry) => {
          const absolute = join(target as string, entry.name);
          const info = await stat(absolute);
          return {
            name: entry.name,
            path: publicPath(absolute),
            type: entry.isDirectory() ? "directory" : "file",
            size: entry.isDirectory() ? 0 : info.size,
            modifiedAt: info.mtime.toISOString()
          };
        }))
      };
    },
    async readFile(_server: ManagedServer, target: string) {
      return { content: await readFile(target as string, "utf8") };
    },
    async downloadFile(_server: ManagedServer, target: string) {
      const info = await stat(target);
      return { filename: basename(target), size: info.size, stream: createReadStream(target) };
    }
  } as unknown as NodeRuntime;
}

async function buildArchive(
  root: string,
  servers: ManagedServer[],
  selection: ExportSelection = everything,
  runtimeOverride?: NodeRuntime
) {
  const runtime = runtimeOverride ?? directoryRuntime();
  const plan = await createExportPlan({
    appVersion: "1.7.0",
    servers,
    selection,
    runtimeForServer: () => runtime,
    modPreferencesForServer: () => ({ "fabric-api.jar": { channel: "release" } })
  });
  const written = await writeExportArchive(join(root, "exports", "artifact.zip"), plan);
  return { plan, written };
}

async function seedServerDirectory(root: string) {
  await Promise.all([
    mkdir(join(root, "config"), { recursive: true }),
    mkdir(join(root, "mods"), { recursive: true }),
    mkdir(join(root, "world", "region"), { recursive: true }),
    mkdir(join(root, "logs"), { recursive: true }),
    mkdir(join(root, "backups"), { recursive: true }),
    mkdir(join(root, "cache"), { recursive: true })
  ]);
  await Promise.all([
    writeFile(join(root, "server.properties"), "server-port=25565\n", "utf8"),
    writeFile(join(root, "whitelist.json"), "[]\n", "utf8"),
    writeFile(join(root, "config", "fabric-api.properties"), "enabled=true\n", "utf8"),
    writeFile(join(root, "mods", "fabric-api.jar"), "PKjar", "utf8"),
    writeFile(join(root, "world", "level.dat"), "leveldata", "utf8"),
    writeFile(join(root, "world", "region", "r.0.0.mca"), "region", "utf8"),
    writeFile(join(root, "logs", "latest.log"), "log line\n", "utf8"),
    writeFile(join(root, "backups", "backup.zip"), "backup", "utf8"),
    writeFile(join(root, "cache", "cached.bin"), "cache", "utf8")
  ]);
}

async function createRepositories(root: string) {
  const storage = openStorageDatabase(join(root, "state.sqlite"));
  openDatabases.push(storage);
  const nodesRepository = new NodesRepository(storage);
  nodesRepository.create({
    id: nodeId,
    name: "Local node",
    type: "local",
    status: "online",
    isInternal: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  });
  return {
    storage,
    nodesRepository,
    // The stored-record normalizer pins serverDir inside the configured data root, which a temporary
    // fixture directory is not; the repository contract under test here is persistence, not shape.
    serversRepository: new ServersRepository(storage, (value) => value as ManagedServer),
    modPreferencesRepository: new ModPreferencesRepository(storage),
    settingsRepository: new SettingsRepository(storage)
  };
}

function manifestFixture(overrides: Partial<ExportManifest["servers"][number]> = {}): ExportManifest {
  const server = managedServer();
  return {
    artifactType: "serversentinel.export",
    schemaVersion: EXPORT_SCHEMA_VERSION,
    manifest: {
      exportedAt: "2026-07-29T00:00:00.000Z",
      appVersion: "1.7.0",
      sqliteSchemaVersion: 20,
      selection: { categories: ["serverConfig"], contentStrategy: "lockfile" },
      content: { servers: 1, files: 1, totalBytes: 10 }
    },
    warnings: [],
    servers: [{
      key: "001-survival",
      server,
      modPreferences: {},
      lockfile: [],
      files: [{ path: "server.properties", size: 10 }],
      ...overrides
    }]
  };
}

describe("export archives", () => {
  it("uses adaptive compression for large and already-compressed members", () => {
    const entry = (archivePath: string, size: number) => ({ sourcePath: archivePath, archivePath, type: "file" as const, size });

    expect(exportArchiveCompressionLevel(entry("manifest.json", 32 * 1024))).toBe(6);
    expect(exportArchiveCompressionLevel(entry("servers/survival/world/region/r.0.0.mca", 8 * 1024 * 1024))).toBe(1);
    expect(exportArchiveCompressionLevel(entry("servers/survival/mods/custom.jar", 8 * 1024 * 1024))).toBe(0);
    expect(exportArchiveCompressionLevel(entry("servers/survival/mods/custom.jar.disabled", 8 * 1024 * 1024))).toBe(0);
  });

  it("writes the archive atomically with restrictive permissions", async () => {
    const root = await tempRoot("serversentinel-export-write-");
    const source = await tempRoot("serversentinel-export-source-");
    await seedServerDirectory(source);

    const { written } = await buildArchive(root, [managedServer({ serverDir: source })]);

    expect(written.size).toBeGreaterThan(0);
    expect(written.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(written.inputBytes).toBeGreaterThan(0);
    expect(written.inputBytesPerSecond).toBeGreaterThan(0);
    expect(written.compression).toMatchObject({ storedEntries: 1, standardEntries: expect.any(Number) });
    expect((await readdir(join(root, "exports"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    if (process.platform !== "win32") {
      expect((await stat(written.path)).mode & 0o077).toBe(0);
      expect((await stat(join(root, "exports"))).mode & 0o077).toBe(0);
    }
  });

  it("atomically persists and hashes a complete ZIP streamed from a remote node", async () => {
    const root = await tempRoot("serversentinel-export-remote-write-");
    const source = await tempRoot("serversentinel-export-remote-source-");
    await seedServerDirectory(source);
    const { plan, written: locallyWritten } = await buildArchive(root, [managedServer({ serverDir: source })]);
    const archive = await readFile(locallyWritten.path);
    const progress: string[] = [];

    const written = await writeDownloadedExportArchive(
      join(root, "remote", "artifact.zip"),
      plan,
      { filename: "artifact.zip", stream: Readable.from([archive]) },
      (_value, task) => progress.push(task)
    );

    expect(await readFile(written.path)).toEqual(archive);
    expect(written.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(written.compression).toEqual(locallyWritten.compression);
    expect(progress.at(-1)).toContain("Receiving remote export archive");
    expect((await readdir(join(root, "remote"))).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("carries the manifest inside the archive alongside the real files", async () => {
    const root = await tempRoot("serversentinel-export-manifest-");
    const source = await tempRoot("serversentinel-export-source-");
    await seedServerDirectory(source);

    const { written } = await buildArchive(root, [managedServer({ serverDir: source })]);
    const manifest = await readExportManifest(written.path);

    expect(manifest.schemaVersion).toBe(EXPORT_SCHEMA_VERSION);
    expect(manifest.servers).toHaveLength(1);
    expect(manifest.servers[0].key).toBe(serverArchiveKey(0, managedServer()));
    expect(manifest.servers[0].server.runtimeProfile.minecraftVersion).toBe("1.21.1");
    expect(manifest.servers[0].modPreferences).toEqual({ "fabric-api.jar": { channel: "release" } });
    const paths = manifest.servers[0].files.map((file) => file.path);
    expect(paths).toContain("world/region/r.0.0.mca");
    expect(paths).toContain("mods/fabric-api.jar");
    expect(paths).toContain("config/fabric-api.properties");
  });

  it("takes only the selected categories", async () => {
    const root = await tempRoot("serversentinel-export-selection-");
    const source = await tempRoot("serversentinel-export-source-");
    await seedServerDirectory(source);

    const { plan } = await buildArchive(root, [managedServer({ serverDir: source })], {
      categories: ["serverConfig", "accessControl"],
      contentStrategy: "lockfile"
    });

    expect(plan.manifest.servers[0].files.map((file) => file.path).sort())
      .toEqual(["server.properties", "whitelist.json"]);
  });

  it("reuses a measured filesystem inventory without walking the server again", async () => {
    const source = await tempRoot("serversentinel-export-inventory-");
    const propertiesPath = join(source, "server.properties");
    await writeFile(propertiesPath, "server-port=25565\n", "utf8");
    const info = await stat(propertiesPath);
    const server = managedServer({ serverDir: source });
    const runtime = directoryRuntime();
    runtime.listFiles = vi.fn(async () => { throw new Error("filesystem walk should not run"); });

    const plan = await createExportPlan({
      appVersion: "1.9.1",
      servers: [server],
      selection: { categories: ["serverConfig"], contentStrategy: "lockfile" },
      runtimeForServer: () => runtime,
      modPreferencesForServer: () => ({}),
      inventoryByServer: new Map([[server.id, [{
        category: "serverConfig",
        files: [{ relativePath: "server.properties", sourcePath: propertiesPath, size: info.size }],
        totalBytes: info.size
      }]]])
    });

    expect(runtime.listFiles).not.toHaveBeenCalled();
    expect(plan.manifest.servers[0].files).toEqual([{ path: "server.properties", size: info.size }]);
  });

  it("never takes regenerable directories even when the world is selected", async () => {
    const root = await tempRoot("serversentinel-export-excluded-");
    const source = await tempRoot("serversentinel-export-source-");
    await seedServerDirectory(source);

    const { plan } = await buildArchive(root, [managedServer({ serverDir: source })]);
    const paths = plan.manifest.servers[0].files.map((file) => file.path);

    expect(paths.some((path) => path.startsWith("backups/"))).toBe(false);
    expect(paths.some((path) => path.startsWith("cache/"))).toBe(false);
  });

  it("drops per-instance runtime state from the exported record", async () => {
    const root = await tempRoot("serversentinel-export-state-");
    const source = await tempRoot("serversentinel-export-source-");
    await seedServerDirectory(source);

    const { plan } = await buildArchive(root, [managedServer({
      serverDir: source,
      runtimeIntent: "running",
      restartPhase: "starting",
      crashAttemptTimestamps: ["2026-01-01T00:00:00.000Z"],
      restartRequiredSince: "2026-01-01T00:00:00.000Z"
    })]);
    const exported = plan.manifest.servers[0].server as Record<string, unknown>;

    expect(exported).not.toHaveProperty("runtimeIntent");
    expect(exported).not.toHaveProperty("restartPhase");
    expect(exported).not.toHaveProperty("crashAttemptTimestamps");
    expect(exported).not.toHaveProperty("restartRequiredSince");
  });

  it("follows level-name to a renamed world folder", async () => {
    const root = await tempRoot("serversentinel-export-level-");
    const source = await tempRoot("serversentinel-export-source-");
    await seedServerDirectory(source);
    await mkdir(join(source, "survival", "region"), { recursive: true });
    await writeFile(join(source, "survival", "region", "r.1.1.mca"), "renamed", "utf8");
    await writeFile(join(source, "server.properties"), "server-port=25565\nlevel-name=survival\n", "utf8");

    const { plan } = await buildArchive(root, [managedServer({ serverDir: source })], {
      categories: ["serverConfig", "world"],
      contentStrategy: "lockfile"
    });
    const paths = plan.manifest.servers[0].files.map((file) => file.path);

    expect(paths).toContain("survival/region/r.1.1.mca");
    // The conventional folder still travels when it exists, so a mixed layout is not truncated.
    expect(paths).toContain("world/level.dat");
  });

  it("ships every jar when the installed content cannot be listed", async () => {
    const root = await tempRoot("serversentinel-export-fallback-");
    const source = await tempRoot("serversentinel-export-source-");
    await seedServerDirectory(source);
    // planServerContent falls back when the mods list is unavailable. Excluding jars on that path
    // would produce an archive with neither a lockfile nor the files.
    const { plan } = await buildArchive(root, [managedServer({ serverDir: source })], {
      categories: ["content"],
      contentStrategy: "lockfile"
    });

    expect(plan.manifest.servers[0].lockfile).toEqual([]);
    expect(plan.manifest.servers[0].files.map((file) => file.path)).toContain("mods/fabric-api.jar");
    expect(plan.manifest.warnings.join(" ")).toMatch(/included in full/);
  });

  it("fails the export when a directory cannot be read", async () => {
    const root = await tempRoot("serversentinel-export-error-");
    const source = await tempRoot("serversentinel-export-source-");
    await seedServerDirectory(source);
    const runtime = directoryRuntime();
    const failing = {
      ...runtime,
      listFiles: async (server: ManagedServer, target: string) => {
        if (String(target).includes("world")) throw new Error("EACCES: permission denied");
        return runtime.listFiles(server, target);
      }
    } as unknown as NodeRuntime;

    // A permissions or node-connectivity failure must not read as "that folder was simply empty".
    await expect(buildArchive(root, [managedServer({ serverDir: source })], {
      categories: ["world"],
      contentStrategy: "lockfile"
    }, failing)).rejects.toThrow(/EACCES/);
  });

  it("omits schedules and java arguments when panel settings are not selected", async () => {
    const root = await tempRoot("serversentinel-export-nopanel-");
    const source = await tempRoot("serversentinel-export-source-");
    await seedServerDirectory(source);

    const { plan } = await buildArchive(root, [managedServer({ serverDir: source })], {
      categories: ["serverConfig"],
      contentStrategy: "lockfile"
    });
    const exported = plan.manifest.servers[0].server as Record<string, unknown>;

    expect(exported).not.toHaveProperty("schedules");
    expect(exported).not.toHaveProperty("javaArgs");
    expect(plan.manifest.servers[0].modPreferences).toEqual({});
    // Ports and image always travel: the record cannot be created or conflict-checked without them.
    expect(exported.dockerPorts).toBe("25565:25565/tcp");
  });
});

describe("import manifest validation", () => {
  it.each([1, 2, 3])("rejects legacy schema-%s exports", (schemaVersion) => {
    const legacy = manifestFixture();
    (legacy as { schemaVersion: number }).schemaVersion = schemaVersion;
    expect(() => assertExportManifest(legacy)).toThrow(/requires export schema 4/);
  });

  it("rejects traversal and absolute paths", () => {
    for (const path of ["../escape.txt", "/etc/passwd", "world\\region\\r.mca", "world/../../escape"]) {
      const manifest = manifestFixture({ files: [{ path, size: 1 }] });
      expect(() => assertExportManifest(manifest)).toThrow(/Import file path/);
    }
  });

  it("rejects an archive key that is not a single path segment", () => {
    expect(() => assertExportManifest(manifestFixture({ key: "../evil" }))).toThrow(/single safe path segment/);
    expect(() => assertExportManifest(manifestFixture({ key: "nested/key" }))).toThrow(/single safe path segment/);
  });

  it("rejects the redundant runtime aliases that schema 3 tolerated", () => {
    const manifest = manifestFixture();
    (manifest.servers[0].server.runtimeProfile as unknown as Record<string, unknown>).loader = "fabric";
    expect(() => assertExportManifest(manifest)).toThrow(/Unsupported .*runtimeProfile content: loader/);
  });

  it("rejects malformed lockfile entries", () => {
    const base = { filename: "fabric-api.jar", enabled: true, projectId: "p", versionId: "v", versionNumber: "1", channel: "release" };
    expect(() => assertExportManifest(manifestFixture({ lockfile: [{ ...base, channel: "nightly" } as never] })))
      .toThrow(/must be release, beta, or alpha/);
    expect(() => assertExportManifest(manifestFixture({ lockfile: [{ ...base, filename: "../evil.jar" } as never] })))
      .toThrow(/must be a local .jar filename/);
    expect(() => assertExportManifest(manifestFixture({ lockfile: [{ ...base, sha1: "nothex" } as never] })))
      .toThrow(/40-character hexadecimal/);
  });

  it("rejects an artifact describing more servers than the limit allows", () => {
    const manifest = manifestFixture();
    manifest.servers = Array.from({ length: 201 }, (_value, index) => ({
      ...manifestFixture().servers[0],
      key: `s-${index}`
    }));
    expect(() => assertExportManifest(manifest)).toThrow(/more than 200 servers/);
  });

  it("reports missing and non-local node targets without writing", () => {
    const manifest = manifestFixture();

    expect(validateImportArchive(manifest, {
      targetNodeId: "",
      localNodeId: nodeId,
      existingServers: [],
      serversDir: "servers",
      tmpDir: "tmp"
    }).issues.map((issue) => issue.code)).toContain("missing_node_target");

    const remote = validateImportArchive(manifest, {
      targetNodeId: "remote-node",
      localNodeId: nodeId,
      existingServers: [],
      serversDir: "servers",
      tmpDir: "tmp"
    });
    expect(remote.valid).toBe(false);
    expect(remote.issues[0].message).toMatch(/only be restored onto the local node/);
  });

  it("quarantines port conflicts without blocking the import and renames colliding display names", () => {
    const existing = managedServer({ id: "00000000-0000-4000-8000-000000000808" });
    const result = validateImportArchive(manifestFixture(), {
      targetNodeId: nodeId,
      localNodeId: nodeId,
      existingServers: [existing],
      serversDir: "servers",
      tmpDir: "tmp"
    });

    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.warnings.map((warning) => warning.code)).toContain("conflicting_port");
    expect(result.warnings.map((warning) => warning.code)).toContain("display_name_renamed");
    expect(result.plan.servers[0].displayName).toBe("Survival (2)");
    expect(result.plan.servers[0].portConflicts).toHaveLength(1);
  });

  it("warns that lockfile content will be re-downloaded", () => {
    const result = validateImportArchive(manifestFixture({
      lockfile: [{ filename: "fabric-api.jar", enabled: true, projectId: "p", versionId: "v", versionNumber: "1", channel: "release" }]
    }), {
      targetNodeId: nodeId,
      localNodeId: nodeId,
      existingServers: [],
      serversDir: "servers",
      tmpDir: "tmp"
    });

    expect(result.warnings.map((warning) => warning.code)).toContain("lockfile_download_required");
    expect(result.plan.servers[0].lockfileCount).toBe(1);
  });
});

describe("import application", () => {
  it("registers a conflicting import as stopped with an unresolved port issue", async () => {
    const root = await tempRoot("serversentinel-import-conflict-");
    const source = await tempRoot("serversentinel-import-source-");
    await seedServerDirectory(source);
    const repositories = await createRepositories(root);
    const existing = managedServer({ id: "00000000-0000-4000-8000-000000000808" });
    const { written } = await buildArchive(root, [managedServer({ serverDir: source })]);
    const manifest = await readExportManifest(written.path);

    const result = await applyImportArchive(written.path, manifest, {
      targetNodeId: nodeId,
      localNodeId: nodeId,
      existingServers: [existing],
      serversDir: join(root, "servers"),
      tmpDir: join(root, "tmp"),
      storage: repositories.storage,
      serversRepository: repositories.serversRepository,
      modPreferencesRepository: repositories.modPreferencesRepository
    });

    expect(result.warnings.map((warning) => warning.code)).toContain("conflicting_port");
    expect(repositories.serversRepository.list()[0]).toMatchObject({
      runtimeIntent: "stopped",
      portConflictUnresolved: true
    });
  });

  it("restores files and registers a server with fresh identifiers", async () => {
    const root = await tempRoot("serversentinel-import-apply-");
    const source = await tempRoot("serversentinel-import-source-");
    await seedServerDirectory(source);
    const repositories = await createRepositories(root);
    const { written } = await buildArchive(root, [managedServer({ serverDir: source })]);
    const manifest = await readExportManifest(written.path);

    const result = await applyImportArchive(written.path, manifest, {
      targetNodeId: nodeId,
      localNodeId: nodeId,
      existingServers: [],
      serversDir: join(root, "servers"),
      tmpDir: join(root, "tmp"),
      storage: repositories.storage,
      serversRepository: repositories.serversRepository,
      modPreferencesRepository: repositories.modPreferencesRepository
    });

    const importedId = result.imported[0].serverId;
    expect(importedId).not.toBe(sourceServerId);
    const imported = repositories.serversRepository.list().find((server) => server.id === importedId)!;
    expect(imported.displayName).toBe("Survival");
    expect(imported.dockerContainer).not.toBe("survival");
    expect(imported.runtimeIntent).toBe("stopped");
    expect(imported.schedules?.[0].id).not.toBe(sourceScheduleId);
    expect(imported.schedules?.[0].steps.map((step) => step.delaySeconds)).toEqual([0, 300]);
    expect(imported.schedules?.[0].recentRuns).toEqual([]);
    expect(repositories.modPreferencesRepository.list(importedId)).toHaveProperty("fabric-api.jar");
    await expect(stat(join(imported.serverDir, "world", "region", "r.0.0.mca"))).resolves.toMatchObject({ size: 6 });
    await expect(stat(join(imported.serverDir, "server.properties"))).resolves.toBeTruthy();
  });

  it("restores a server when the staging directory is on another filesystem", async () => {
    const root = await tempRoot("serversentinel-import-exdev-");
    const source = await tempRoot("serversentinel-import-source-");
    await seedServerDirectory(source);
    const repositories = await createRepositories(root);
    const { written } = await buildArchive(root, [managedServer({ serverDir: source })]);
    const manifest = await readExportManifest(written.path);
    deviceBoundary.from = join(root, "tmp");
    deviceBoundary.to = join(root, "servers");

    const result = await applyImportArchive(written.path, manifest, {
      targetNodeId: nodeId,
      localNodeId: nodeId,
      existingServers: [],
      serversDir: join(root, "servers"),
      tmpDir: join(root, "tmp"),
      storage: repositories.storage,
      serversRepository: repositories.serversRepository,
      modPreferencesRepository: repositories.modPreferencesRepository
    });

    const imported = repositories.serversRepository.list().find((server) => server.id === result.imported[0].serverId)!;
    await expect(stat(join(imported.serverDir, "world", "region", "r.0.0.mca"))).resolves.toMatchObject({ size: 6 });
    await expect(stat(join(imported.serverDir, "server.properties"))).resolves.toBeTruthy();
    // The copy stands in for a move, so it must not leave a second copy of the world behind.
    await expect(readdir(join(root, "tmp"))).resolves.toEqual([]);
  });

  it("downloads the runtime jar the archive deliberately left out", async () => {
    const root = await tempRoot("serversentinel-import-jar-");
    const source = await tempRoot("serversentinel-import-source-");
    await seedServerDirectory(source);
    const repositories = await createRepositories(root);
    const { written } = await buildArchive(root, [managedServer({ serverDir: source })]);
    const manifest = await readExportManifest(written.path);
    // The jar is never an archive member, so without this call an imported server has nothing to run.
    expect(manifest.servers[0].files.map((file) => file.path)).not.toContain("fabric-server-launch.jar");
    const downloaded: string[] = [];

    const result = await applyImportArchive(written.path, manifest, {
      targetNodeId: nodeId,
      localNodeId: nodeId,
      existingServers: [],
      serversDir: join(root, "servers"),
      tmpDir: join(root, "tmp"),
      storage: repositories.storage,
      serversRepository: repositories.serversRepository,
      modPreferencesRepository: repositories.modPreferencesRepository,
      restoreRuntimeJar: async (server) => { downloaded.push(server.displayName); }
    });

    expect(downloaded).toEqual(["Survival"]);
    expect(result.runtimeJarFailures).toEqual([]);
  });

  it("reports a failed runtime download without discarding the restored files", async () => {
    const root = await tempRoot("serversentinel-import-jar-fail-");
    const source = await tempRoot("serversentinel-import-source-");
    await seedServerDirectory(source);
    const repositories = await createRepositories(root);
    const { written } = await buildArchive(root, [managedServer({ serverDir: source })]);
    const manifest = await readExportManifest(written.path);

    const result = await applyImportArchive(written.path, manifest, {
      targetNodeId: nodeId,
      localNodeId: nodeId,
      existingServers: [],
      serversDir: join(root, "servers"),
      tmpDir: join(root, "tmp"),
      storage: repositories.storage,
      serversRepository: repositories.serversRepository,
      modPreferencesRepository: repositories.modPreferencesRepository,
      restoreRuntimeJar: async () => { throw new Error("MCJars is unreachable"); }
    });

    // Rolling back a restored world over a failed download would be the worse outcome.
    expect(result.imported).toHaveLength(1);
    expect(result.runtimeJarFailures).toEqual([{ serverName: "Survival", reason: "MCJars is unreachable" }]);
    const imported = repositories.serversRepository.list()[0];
    await expect(stat(join(imported.serverDir, "world", "level.dat"))).resolves.toBeTruthy();
  });

  it("reports content that Modrinth can no longer supply without failing the import", async () => {
    const root = await tempRoot("serversentinel-import-content-");
    const source = await tempRoot("serversentinel-import-source-");
    await seedServerDirectory(source);
    const repositories = await createRepositories(root);
    const { written } = await buildArchive(root, [managedServer({ serverDir: source })]);
    const manifest = await readExportManifest(written.path);
    manifest.servers[0].lockfile = [{
      filename: "gone.jar",
      enabled: true,
      projectId: "p",
      versionId: "v",
      versionNumber: "9.9.9",
      channel: "release"
    }];

    const result = await applyImportArchive(written.path, manifest, {
      targetNodeId: nodeId,
      localNodeId: nodeId,
      existingServers: [],
      serversDir: join(root, "servers"),
      tmpDir: join(root, "tmp"),
      storage: repositories.storage,
      serversRepository: repositories.serversRepository,
      modPreferencesRepository: repositories.modPreferencesRepository,
      restoreContent: async () => ({ restored: 0, failures: [{ filename: "gone.jar", reason: "no longer available" }] })
    });

    expect(result.imported).toHaveLength(1);
    expect(result.contentFailures).toEqual([
      { serverName: "Survival", filename: "gone.jar", reason: "no longer available" }
    ]);
  });

  it("rolls back SQLite rows and staged files when registration fails", async () => {
    const root = await tempRoot("serversentinel-import-rollback-");
    const source = await tempRoot("serversentinel-import-source-");
    await seedServerDirectory(source);
    const repositories = await createRepositories(root);
    const { written } = await buildArchive(root, [managedServer({ serverDir: source })]);
    const manifest = await readExportManifest(written.path);

    await expect(applyImportArchive(written.path, manifest, {
      targetNodeId: nodeId,
      localNodeId: nodeId,
      existingServers: [],
      serversDir: join(root, "servers"),
      tmpDir: join(root, "tmp"),
      storage: repositories.storage,
      serversRepository: repositories.serversRepository,
      modPreferencesRepository: {
        replaceAll() {
          throw new Error("preference write failed");
        }
      } as unknown as ModPreferencesRepository
    })).rejects.toThrow("preference write failed");

    expect(repositories.serversRepository.list()).toEqual([]);
    expect(await readdir(join(root, "servers"))).toEqual([]);
  });
});
