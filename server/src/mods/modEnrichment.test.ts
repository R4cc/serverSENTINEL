import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { services, runtimeForServer } from "../appServices.js";
import { modrinthFetch } from "../modrinth/modrinthClient.js";
import { resetModrinthMetadataCachesForTests } from "../modrinth/compatibility.js";
import { RemoteNodeRuntime } from "../nodes/remoteNodeRuntime.js";
import type { NodeRuntime } from "../nodes/types.js";
import { StorageDatabase } from "../storage/database.js";
import { ModPreferencesRepository } from "../storage/modPreferencesRepository.js";
import type { ManagedServer, ModPreference, ModrinthVersion } from "../types.js";
import { buildModUpdatePlan, listModsWithPanelMetadata, localListMods } from "./modService.js";
import { createModUpdatePlan } from "../modrinth/updatePlan.js";

vi.mock("../appServices.js", () => ({ services: {}, runtimeForServer: vi.fn() }));
vi.mock("../modrinth/modrinthClient.js", () => ({ modrinthFetch: vi.fn() }));

let directory: string;
let database: StorageDatabase;
let server: ManagedServer;
let versions: Map<string, ModrinthVersion>;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "serversentinel-mod-enrichment-"));
  await mkdir(join(directory, "mods"));
  database = new StorageDatabase(join(directory, "test.sqlite"));
  database.connection.exec(`INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at) VALUES ('local', 'Local', 'local', 'online', 1, '', '');
    INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, created_at, updated_at) VALUES ('server-1', 'local', 'Test', '/test', '{}', '', '')`);
  services.modPreferencesRepository = new ModPreferencesRepository(database);
  server = { id: "server-1", nodeId: "local", serverDir: directory, runtimeProfile: { runtimeType: "fabric", minecraftVersion: "1.21.4", jarArtifact: { filename: "server.jar" } } } as ManagedServer;
  versions = new Map();
  resetModrinthMetadataCachesForTests();
  vi.mocked(modrinthFetch).mockReset().mockImplementation(respond);
});

afterEach(async () => {
  services.modUpdatePlanCoordinator = undefined;
  database?.close();
  await rm(directory, { recursive: true, force: true });
});

async function respond(url: string, options?: { json?: unknown }) {
  const parsed = new URL(url);
  if (parsed.pathname === "/v2/version_files") {
    const hashes = (options?.json as { hashes: string[] }).hashes;
    return new Response(JSON.stringify(Object.fromEntries(hashes.flatMap(hash => versions.has(hash) ? [[hash, versions.get(hash)]] : []))));
  }
  if (parsed.pathname === "/v2/projects") {
    const ids = JSON.parse(parsed.searchParams.get("ids")!) as string[];
    return new Response(JSON.stringify(ids.map(id => ({ id, title: id, server_side: "required", client_side: "optional" }))));
  }
  if (parsed.pathname.includes("/project/") && parsed.pathname.endsWith("/version")) {
    const projectId = parsed.pathname.split("/")[3];
    return new Response(JSON.stringify([...versions.values()].filter(version => version.project_id === projectId)));
  }
  throw new Error(`Unexpected unbatched Modrinth request: ${url}`);
}

async function addJar(index: number, recognized = true) {
  const filename = `mod-${index}.jar`;
  const bytes = Buffer.from(`PK\u0003\u0004jar-${index}`);
  await writeFile(join(directory, "mods", filename), bytes);
  const hash = createHash("sha1").update(bytes).digest("hex");
  if (recognized) versions.set(hash, { id: `version-${index}`, project_id: `project-${index}`, version_number: "1", version_type: "release", loaders: ["fabric"], game_versions: ["1.21.4"], files: [{ filename, primary: true, url: "https://cdn.modrinth.com/test.jar", hashes: { sha1: hash } }] });
  return { filename, hash };
}

function newerPreference(): ModPreference {
  return { channel: "alpha", modrinth: { projectId: "new-project", versionId: "new-version", versionNumber: "2", filename: "new.jar", loaders: ["fabric"], gameVersions: ["1.21.4"], installedAt: "2026-10-02T00:00:00Z", installedWithForceIncompatible: false } };
}

describe("local batched mod identification", () => {
  it("refreshes changed inventory from saved metadata without Modrinth requests or losing unchanged version checks", async () => {
    await addJar(0);
    await addJar(1);
    const previous = await localListMods(server, { forceRefresh: true });
    const plan = createModUpdatePlan(server.id, previous.mods);
    services.modUpdatePlanCoordinator = { getInstalled: () => ({ ...previous, scannedAt: plan.generatedAt }),
      get: () => plan } as unknown as NonNullable<typeof services.modUpdatePlanCoordinator>;
    vi.mocked(runtimeForServer).mockReturnValue({ listMods: localListMods } as unknown as NodeRuntime);
    await rename(join(directory, "mods", "mod-0.jar"), join(directory, "mods", "mod-0.jar.disabled"));
    await writeFile(join(directory, "mods", "mod-1.jar"), Buffer.from("PK\u0003\u0004replaced-content"));
    vi.mocked(modrinthFetch).mockClear();
    const scan = await buildModUpdatePlan(server, { includeInstalled: true, forceRefresh: false });
    expect(scan.installedMods?.mods[0]).toMatchObject({ filename: "mod-0.jar.disabled", enabled: false,
      versionInfo: { upToDate: true } });
    expect(scan.installedMods?.mods[1].versionInfo).toBeNull();
    expect(vi.mocked(modrinthFetch)).not.toHaveBeenCalled();
  });

  it.each([100, 101])("batches %s hashes and projects and reports completed item progress", async (count) => {
    await Promise.all(Array.from({ length: count }, (_, index) => addJar(index)));
    const progress: Array<{ checked: number; total: number }> = [];
    const result = await localListMods(server, { forceRefresh: true, onProgress: current => progress.push(current) });
    const calls = vi.mocked(modrinthFetch).mock.calls;
    expect(calls.filter(([url]) => new URL(url).pathname === "/v2/version_files")).toHaveLength(Math.ceil(count / 100));
    expect(calls.filter(([url]) => new URL(url).pathname === "/v2/projects")).toHaveLength(Math.ceil(count / 100));
    expect(calls.some(([url]) => url.includes("/version_file/"))).toBe(false);
    expect(result.mods).toHaveLength(count);
    expect(result.mods.every(mod => mod.modrinth && mod.compatibility.compatible && mod.versionInfo?.upToDate)).toBe(true);
    expect(progress[0]).toEqual({ checked: 0, total: count });
    expect(progress.at(-1)).toEqual({ checked: count, total: count });
    expect(progress.map(current => current.checked)).toEqual(Array.from({ length: count + 1 }, (_, index) => index));
  });

  it("leaves unknown jars unmanaged without repeating individual identification", async () => {
    await addJar(0);
    await addJar(1, false);
    const result = await localListMods(server, { forceRefresh: true });
    expect(result.mods[0].modrinth?.projectId).toBe("project-0");
    expect(result.mods[1].modrinth).toBeUndefined();
    expect(vi.mocked(modrinthFetch).mock.calls.some(([url]) => url.includes("/version_file/"))).toBe(false);
  });

  it("finishes an unavailable identification batch without losing saved preferences", async () => {
    await addJar(0, false);
    services.modPreferencesRepository.replaceAll(server.id, { "mod-0.jar": { channel: "beta" } });
    vi.mocked(modrinthFetch).mockRejectedValue(new Error("upstream unavailable"));
    const progress = vi.fn();
    const result = await localListMods(server, { forceRefresh: true, onProgress: progress });
    expect(result.mods[0].preferredChannel).toBe("beta");
    expect(progress).toHaveBeenLastCalledWith({ checked: 1, total: 1 });
    expect(services.modPreferencesRepository.list(server.id)["mod-0.jar"].channel).toBe("beta");
    expect(modrinthFetch).toHaveBeenCalledTimes(1);
  });
});

describe.each(["local", "remote"])("%s scan preferences concurrency", (kind) => {
  it("does not persist late enrichment after its module stops and the database closes", async () => {
    const { filename, hash } = await addJar(0);
    let release!: () => void;
    let entered!: () => void;
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(modrinthFetch).mockImplementation(async (url, options) => {
      if (url.endsWith("/version_files")) { entered(); await gate; }
      return respond(url, options);
    });
    if (kind === "remote") {
      const runtime = Object.create(RemoteNodeRuntime.prototype) as NodeRuntime;
      runtime.listMods = vi.fn(async () => ({ mods: [{ filename, sha1: hash, enabled: true }] }));
      vi.mocked(runtimeForServer).mockReturnValue(runtime);
    }
    const controller = new AbortController();
    const commit = vi.spyOn(services.modPreferencesRepository, "replaceAllIfUnchanged");
    const pending = kind === "local" ? localListMods(server, { forceRefresh: true, signal: controller.signal })
      : listModsWithPanelMetadata(server, { forceRefresh: true, signal: controller.signal });
    await admitted;
    controller.abort();
    database.close();
    release();
    await pending;
    expect(commit).not.toHaveBeenCalled();
  });

  it.each(["install", "remove", "update", "toggle"])("preserves a newer %s while metadata identification is pending", async (action) => {
    const { filename, hash } = await addJar(0);
    services.modPreferencesRepository.replaceAll(server.id, { [filename]: { channel: "beta" } });
    let release!: () => void;
    let entered!: () => void;
    const admitted = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(modrinthFetch).mockImplementation(async (url, options) => {
      if (url.endsWith("/version_files")) { entered(); await gate; }
      return respond(url, options);
    });
    if (kind === "remote") {
      const runtime = Object.create(RemoteNodeRuntime.prototype) as NodeRuntime;
      runtime.listMods = vi.fn(async () => ({ mods: [{ filename, sha1: hash, enabled: true }] }));
      vi.mocked(runtimeForServer).mockReturnValue(runtime);
    }
    const pending = kind === "local" ? localListMods(server, { forceRefresh: true }) : listModsWithPanelMetadata(server, { forceRefresh: true });
    await admitted;
    const newer = action === "remove" ? {} : action === "toggle" ? { [`${filename}.disabled`]: { channel: "alpha" } as ModPreference }
      : action === "update" ? { [filename]: { ...newerPreference(), modrinth: { ...newerPreference().modrinth!, filename } } }
      : { [filename]: { channel: "alpha" } as ModPreference, "new.jar": newerPreference() };
    services.modPreferencesRepository.replaceAll(server.id, newer);
    release();
    await pending;
    expect(services.modPreferencesRepository.list(server.id)).toEqual(newer);
  });
});
