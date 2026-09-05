import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { services, runtimeForServer } from "../appServices.js";
import { StorageDatabase } from "../storage/database.js";
import { ModPreferencesRepository } from "../storage/modPreferencesRepository.js";
import type { ManagedServer, ModPreference } from "../types.js";
import type { NodeRuntime, RuntimeUploadSource } from "../nodes/types.js";
import { modHistoryRepository, modRevertConflict, modRevertPermission, publicModHistoryEntry, readModHistorySnapshot, revertModHistoryEntry } from "./modHistory.js";
import { withRecordedModMutation } from "./modService.js";

vi.mock("../appServices.js", () => ({ services: {}, runtimeForServer: vi.fn() }));

const actor = { id: "user-1", username: "operator" };
const server = { id: "server-1", nodeId: "local", displayName: "Test", runtimeProfile: { runtimeType: "fabric", minecraftVersion: "1.21.4", jarArtifact: { filename: "server.jar" } } } as ManagedServer;
let directory: string;
let database: StorageDatabase;
let files: Map<string, Buffer>;
let runtime: ReturnType<typeof fakeRuntime>;

function jar(version: string) { return Buffer.from(`PK\u0003\u0004jar-${version}`); }
function sha1(content: Buffer) { return createHash("sha1").update(content).digest("hex"); }
function preference(filename: string, version: string): ModPreference {
  return { channel: "beta", modrinth: { projectId: "testmod", versionId: `version${version}`, filename, versionNumber: version,
    versionType: "release", gameVersions: ["1.21.4"], loaders: ["fabric"], hashes: { sha1: sha1(jar(version)) }, installedAt: "2026-09-01T00:00:00.000Z", installedWithForceIncompatible: false } };
}
function put(filename: string, version: string, managed = true) {
  files.set(filename, jar(version));
  if (managed) services.modPreferencesRepository.replaceAll(server.id, { ...services.modPreferencesRepository.list(server.id), [filename]: preference(filename, version) });
}
function fakeRuntime() {
  return {
    resolveExistingPath: vi.fn(async (_server: ManagedServer, path: string) => path),
    serverStatus: vi.fn(async () => ({ running: false })),
    listMods: vi.fn(async () => ({ mods: [...files].map(([filename, bytes]) => ({ filename, displayName: "Test mod", enabled: !filename.endsWith(".disabled"), sha1: sha1(bytes), modrinth: services.modPreferencesRepository.list(server.id)[filename]?.modrinth })) })),
    downloadFile: vi.fn(async (_server: ManagedServer, path: string) => {
      const bytes = files.get(path.split("/").at(-1)!)!;
      return { filename: path, size: bytes.length, stream: Readable.from([bytes]) };
    }),
    removeMod: vi.fn(async (_server: ManagedServer, filename: string) => {
      files.delete(filename);
      const preferences = services.modPreferencesRepository.list(server.id);
      delete preferences[filename];
      services.modPreferencesRepository.replaceAll(server.id, preferences);
      return { ok: true };
    }),
    uploadMod: vi.fn(async (_server: ManagedServer, filename: string, upload: RuntimeUploadSource) => {
      if (files.has(filename)) throw new Error("File exists");
      const chunks: Buffer[] = [];
      for await (const chunk of upload.stream) chunks.push(Buffer.from(chunk));
      files.set(filename, Buffer.concat(chunks));
      return { ok: true };
    }),
    toggleMod: vi.fn(async (_server: ManagedServer, filename: string, enabled: boolean) => {
      const next = filename.replace(/\.disabled$/, "") + (enabled ? "" : ".disabled");
      files.set(next, files.get(filename)!);
      files.delete(filename);
      return { filename: next };
    })
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "serversentinel-mod-history-"));
  database = new StorageDatabase(join(directory, "test.sqlite"));
  database.connection.exec(`INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at) VALUES ('local', 'Local', 'local', 'online', 1, '', '');
    INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, created_at, updated_at) VALUES ('server-1', 'local', 'Test', '/test', '{}', '', '')`);
  Object.assign(services, {
    storageDatabase: database,
    modPreferencesRepository: new ModPreferencesRepository(database),
    exportCoordinator: { withMutation: (_id: string, action: () => Promise<unknown>) => action() },
    operationsRepository: { listActive: () => [] },
    serversRepository: { beginModRestartTracking: vi.fn(), updateModRestartChanges: vi.fn() }
  });
  files = new Map();
  runtime = fakeRuntime();
  vi.mocked(runtimeForServer).mockReturnValue(runtime as unknown as NodeRuntime);
});
afterEach(async () => {
  database?.close();
  vi.restoreAllMocks();
  await rm(directory, { recursive: true, force: true });
});

async function revert(id: string) {
  const entry = modHistoryRepository().list(server.id).find((item) => item.id === id)!;
  return withRecordedModMutation(server, actor, () => revertModHistoryEntry(server, entry), id);
}

describe("persistent mod update history", () => {
  it("records installs and dependencies individually, and undoes only the selected installation", async () => {
    await withRecordedModMutation(server, actor, async () => { put("test.jar", "1"); put("dependency.jar", "1", false); });
    const entries = modHistoryRepository().list(server.id);
    expect(entries).toHaveLength(2);
    const installed = entries.find((entry) => entry.after?.filename === "test.jar")!;
    expect(installed).toMatchObject({ action: "installed", before: null, user: actor, after: { version: "1" } });
    expect(modRevertPermission(installed)).toBe("mods.remove");
    await revert(installed.id);
    expect([...files.keys()]).toEqual(["dependency.jar"]);
    expect(modHistoryRepository().list(server.id)[0].revertsEntryId).toBe(installed.id);
    expect(modHistoryRepository().list(server.id).find((entry) => entry.id === installed.id)?.revertedAt).toBeTruthy();
    await expect(revert(installed.id)).rejects.toThrow("already been reverted");
  });

  it("restores the exact pre-update bytes, version, disabled state and channel after a database reopen", async () => {
    put("old.jar.disabled", "1");
    await withRecordedModMutation(server, actor, async () => { await runtime.removeMod(server, "old.jar.disabled"); put("new.jar.disabled", "2"); });
    const entry = modHistoryRepository().list(server.id)[0];
    expect(entry).toMatchObject({ action: "updated", before: { version: "1" }, after: { version: "2" } });
    database.close();
    database = new StorageDatabase(join(directory, "test.sqlite"));
    services.storageDatabase = database;
    services.modPreferencesRepository = new ModPreferencesRepository(database);
    await revert(entry.id);
    expect(files.get("old.jar.disabled")).toEqual(jar("1"));
    expect(files.has("new.jar.disabled")).toBe(false);
    expect(services.modPreferencesRepository.list(server.id)["old.jar.disabled"]).toEqual(preference("old.jar.disabled", "1"));
  });

  it("restores manually uploaded jars after deletion without consulting Modrinth", async () => {
    put("manual.jar", "custom", false);
    await withRecordedModMutation(server, actor, () => runtime.removeMod(server, "manual.jar"));
    const entry = modHistoryRepository().list(server.id)[0];
    expect(entry.before?.version).toBeNull();
    expect(modRevertPermission(entry)).toBe("mods.upload");
    await revert(entry.id);
    expect(files.get("manual.jar")).toEqual(jar("custom"));
  });

  it("rejects newer state and filename collisions before changing installed files", async () => {
    put("old.jar", "1");
    await withRecordedModMutation(server, actor, async () => { await runtime.removeMod(server, "old.jar"); put("new.jar", "2"); });
    const entry = modHistoryRepository().list(server.id)[0];
    put("old.jar", "unrelated", false);
    expect(modRevertConflict(entry, await readModHistorySnapshot(server))).toMatch(/Another installed mod/);
    files.delete("old.jar");
    put("new.jar", "3");
    const removeCount = runtime.removeMod.mock.calls.length;
    await expect(revert(entry.id)).rejects.toThrow("changed since");
    expect(runtime.removeMod.mock.calls).toHaveLength(removeCount);
    expect(files.get("new.jar")).toEqual(jar("3"));
  });

  it("recovers the current version when restoration fails, without marking the action reverted", async () => {
    put("old.jar", "1");
    await withRecordedModMutation(server, actor, async () => { await runtime.removeMod(server, "old.jar"); put("new.jar", "2"); });
    const entry = modHistoryRepository().list(server.id)[0];
    runtime.uploadMod.mockRejectedValueOnce(new Error("Node upload failed"));
    await expect(revert(entry.id)).rejects.toThrow("Node upload failed");
    expect(files.get("new.jar")).toEqual(jar("2"));
    expect(files.has("old.jar")).toBe(false);
    expect(modHistoryRepository().list(server.id)).toHaveLength(1);
    expect(modHistoryRepository().list(server.id)[0].revertedAt).toBeNull();
  });

  it("rejects corrupt backups before deleting anything", async () => {
    put("test.jar", "1");
    await withRecordedModMutation(server, actor, () => runtime.removeMod(server, "test.jar"));
    const entry = modHistoryRepository().list(server.id)[0];
    const archive = join(directory, "mod-history", (await readdir(join(directory, "mod-history")))[0], `${entry.before!.sha1}.jar`);
    await writeFile(archive, "corrupt");
    runtime.removeMod.mockClear();
    await expect(revert(entry.id)).rejects.toThrow("integrity check");
    expect(runtime.removeMod).not.toHaveBeenCalled();
    expect(files.size).toBe(0);
  });

  it("records successful changes from a failed batch, but no history for a failed no-op", async () => {
    await expect(withRecordedModMutation(server, actor, async () => { throw new Error("Download failed"); })).rejects.toThrow();
    expect(modHistoryRepository().list(server.id)).toHaveLength(0);
    await expect(withRecordedModMutation(server, actor, async () => { put("test.jar", "1"); throw new Error("Second download failed"); })).rejects.toThrow();
    expect(modHistoryRepository().list(server.id)).toHaveLength(1);
  });

  it("shares the mutation lock and updates restart tracking", async () => {
    runtime.serverStatus.mockResolvedValue({ running: true });
    put("test.jar", "1");
    await withRecordedModMutation(server, actor, async () => {
      await expect(withRecordedModMutation(server, actor, async () => undefined)).rejects.toThrow("already running");
      put("test.jar", "2");
    });
    expect(services.serversRepository.updateModRestartChanges).toHaveBeenCalledWith(server.id, [expect.objectContaining({ action: "updated" })]);
  });

  it("caps retained history, scopes it to the server, and strips internal backup metadata", async () => {
    await withRecordedModMutation(server, actor, async () => { put("test.jar", "1"); });
    const entry = modHistoryRepository().list(server.id)[0];
    modHistoryRepository().append(server.id, Array.from({ length: 510 }, (_, index) => ({ ...entry, id: `history-${index}` })));
    expect(modHistoryRepository().list(server.id)).toHaveLength(500);
    expect(modHistoryRepository().list("other-server")).toEqual([]);
    const view = publicModHistoryEntry(entry, null);
    expect(view.after).toEqual({ filename: "test.jar", version: "1", enabled: true });
    expect(JSON.stringify(view)).not.toContain("sha1");
    database.connection.prepare("DELETE FROM servers WHERE id = ?").run(server.id);
    expect(modHistoryRepository().list(server.id)).toEqual([]);
  });

  it("retains the available icon after a mod is removed and accepts older snapshots", async () => {
    const iconUrl = "https://cdn.modrinth.com/data/testmod/icon.png";
    const listMods = runtime.listMods.getMockImplementation()!;
    runtime.listMods.mockImplementation(async () => {
      const result = await listMods();
      return { mods: result.mods.map((mod) => ({ ...mod, iconUrl })) };
    });
    put("test.jar", "1");
    await withRecordedModMutation(server, actor, () => runtime.removeMod(server, "test.jar"));
    const entry = modHistoryRepository().list(server.id)[0];
    expect(entry.before?.iconUrl).toBe(iconUrl);
    expect(publicModHistoryEntry(entry, null).iconUrl).toBe(iconUrl);
    delete entry.before!.iconUrl;
    expect(publicModHistoryEntry(entry, null).iconUrl).toBeUndefined();
  });
});
