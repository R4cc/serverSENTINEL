import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ManagedServer } from "../types.js";

const upstream = vi.hoisted(() => vi.fn(async () => new Response("{}", { status: 200 })));
vi.mock("../modrinth/modrinthClient.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../modrinth/modrinthClient.js")>(),
  modrinthFetch: upstream
}));

const originalEnv = { ...process.env };
let dataDirectory: string | undefined;

afterEach(async () => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.resetModules();
  upstream.mockClear();
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
  dataDirectory = undefined;
});

it("serves installed mods and update plans from persistent cache, and scans only on explicit checks", async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "serversentinel-mod-cache-api-"));
  process.env = {
    ...originalEnv, SS_MODE: "all-in-one", SERVERSENTINEL_DATA_DIR: dataDirectory,
    SERVERSENTINEL_ENABLE_DEMO: "false", SERVERSENTINEL_SERVERS_DOCKER_VOLUME: "", LOG_LEVEL: "silent"
  };
  vi.resetModules();
  const { buildApp } = await import("../app.js");
  const { services, runtimeForServer } = await import("../appServices.js");
  const { hashPasswordAsync } = await import("../auth/passwords.js");
  const { ALL_PERMISSIONS } = await import("../permissions.js");
  const { ModUpdatePlanRepository } = await import("../storage/modUpdatePlanRepository.js");
  const { createModUpdatePlan } = await import("../modrinth/updatePlan.js");
  let app = await buildApp();
  try {
    services.usersRepository.create({
      id: "cache-operator", username: "operator", ...await hashPasswordAsync("test-password"), rolePreset: "admin",
      permissions: [...ALL_PERMISSIONS], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    const server: ManagedServer = {
      id: "11111111-1111-4111-8111-111111111111", nodeId: "local", displayName: "Cache test",
      serverDir: join(dataDirectory, "servers", "cache-test"), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      runtimeProfile: {
        runtimeType: "fabric", minecraftVersion: "1.21.4", runtimeVersion: "0.16.10", javaMajorVersion: 21,
        jarProvider: "mcjars", jarArtifact: { filename: "fabric-server-launch.jar", downloadUrl: "https://example.invalid/server.jar" },
        compatibilityStatus: "compatible", resolvedAt: new Date().toISOString()
      }
    };
    await mkdir(join(server.serverDir, "mods"), { recursive: true });
    await writeFile(join(server.serverDir, "mods", "manual.jar"), Buffer.from("PK\u0003\u0004manual-jar"));
    services.serversRepository.create(server);
    const runtime = runtimeForServer(server);
    const list = vi.spyOn(runtime, "listMods");
    vi.spyOn(runtime, "serverStatus").mockResolvedValue({ running: false });
    const login = await app.inject({
      method: "POST", url: "/api/auth/login", headers: { "x-requested-with": "XMLHttpRequest" },
      payload: { username: "operator", password: "test-password" }
    });
    expect(login.statusCode, login.body).toBe(200);
    const headers = { cookie: String(login.headers["set-cookie"]).split(";", 1)[0], "x-requested-with": "XMLHttpRequest" };
    const base = `/api/servers/${server.id}/mods`;
    upstream.mockClear();
    const empty = await app.inject({ method: "GET", url: base, headers });
    expect(empty.statusCode, empty.body).toBe(200);
    expect(empty.json()).toEqual({ mods: [], scannedAt: null });
    expect((await app.inject({ method: "GET", url: `${base}/update-plan?channel=beta`, headers })).json()).toBeNull();
    expect(list).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();

    const generatedAt = new Date().toISOString();
    const repository = new ModUpdatePlanRepository(services.storageDatabase);
    const cachedPlan = createModUpdatePlan(server.id, [], generatedAt);
    repository.set(cachedPlan, {
      scannedAt: generatedAt,
      mods: [{
        filename: "cached.jar", displayName: "Cached", enabled: true, size: 42, sha1: "private-sha1",
        modrinth: { projectId: "cached-project", hashes: { sha1: "private-metadata-hash" } },
        compatibility: { compatible: true, file: { filename: "cached.jar", size: 42, hashes: { sha1: "private-file-hash" }, url: "https://example.invalid/private" } }
      }]
    });
    for (const url of [base, base, `${base}/update-plan`, `${base}/update-plan?channel=alpha`]) {
      const response = await app.inject({ method: "GET", url, headers });
      expect(response.statusCode, response.body).toBe(200);
      if (url.includes("update-plan")) expect(response.json()).toEqual(cachedPlan);
      else {
        expect(response.json()).toMatchObject({ scannedAt: generatedAt, mods: [{ filename: "cached.jar" }] });
        expect(response.body).not.toMatch(/sha1|hashes|private-/);
      }
    }
    expect(list).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();

    const checked = await app.inject({ method: "GET", url: `${base}?forceRefresh=true`, headers });
    expect(checked.statusCode, checked.body).toBe(200);
    expect(checked.json()).toMatchObject({ mods: [{ filename: "manual.jar", enabled: true }] });
    expect(typeof checked.json().scannedAt).toBe("string");
    expect(checked.body).not.toContain("sha1");
    expect(list).toHaveBeenCalledTimes(1);
    expect(upstream).toHaveBeenCalled();
    let successfulSnapshot = checked.json();
    list.mockClear();
    upstream.mockClear();
    let refreshedPlan = await app.inject({ method: "GET", url: `${base}/update-plan`, headers });
    expect(refreshedPlan.json().counts.totalInstalled).toBe(1);
    expect((await app.inject({ method: "GET", url: base, headers })).json()).toEqual(successfulSnapshot);
    expect(list).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();

    const checkedPlan = await app.inject({ method: "GET", url: `${base}/update-plan?forceRefresh=true`, headers });
    expect(checkedPlan.statusCode, checkedPlan.body).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);
    refreshedPlan = checkedPlan;
    successfulSnapshot = (await app.inject({ method: "GET", url: base, headers })).json();
    expect(Number.isFinite(Date.parse(successfulSnapshot.scannedAt))).toBe(true);
    list.mockClear();
    const alternate = await app.inject({ method: "GET", url: `${base}/update-plan?forceRefresh=true&channel=beta`, headers });
    expect(alternate.statusCode, alternate.body).toBe(200);
    expect(list).toHaveBeenCalledTimes(1);
    expect((await app.inject({ method: "GET", url: base, headers })).json()).toEqual(successfulSnapshot);
    expect((await app.inject({ method: "GET", url: `${base}/update-plan`, headers })).json()).toEqual(checkedPlan.json());

    upstream.mockClear();
    const toggled = await app.inject({ method: "PATCH", url: base, headers,
      payload: { filename: "manual.jar", enabled: false } });
    expect(toggled.statusCode, toggled.body).toBe(200);
    successfulSnapshot = (await app.inject({ method: "GET", url: base, headers })).json();
    expect(successfulSnapshot.mods).toMatchObject([{ filename: "manual.jar.disabled", enabled: false }]);
    refreshedPlan = await app.inject({ method: "GET", url: `${base}/update-plan`, headers });
    expect(refreshedPlan.json().generatedAt).toBe(checkedPlan.json().generatedAt);
    expect(upstream).not.toHaveBeenCalled();
    list.mockClear();
    await app.inject({ method: "GET", url: base, headers });
    expect(list).not.toHaveBeenCalled();

    list.mockRejectedValue(new Error("Node offline"));
    const failedCheck = await app.inject({ method: "GET", url: `${base}?forceRefresh=true`, headers });
    expect(failedCheck.statusCode).toBeGreaterThanOrEqual(400);
    expect((await app.inject({ method: "GET", url: base, headers })).json()).toEqual(successfulSnapshot);
    await app.close();
    app = await buildApp();
    const offlineList = vi.spyOn(runtimeForServer(server), "listMods").mockRejectedValue(new Error("Node offline after restart"));
    upstream.mockClear();
    expect((await app.inject({ method: "GET", url: base, headers })).json()).toEqual(successfulSnapshot);
    expect((await app.inject({ method: "GET", url: `${base}/update-plan?channel=beta`, headers })).json()).toEqual(refreshedPlan.json());
    expect(offlineList).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    expect((await app.inject({ method: "GET", url: base, headers: { "x-requested-with": "XMLHttpRequest" } })).statusCode).toBe(401);
    await services.moduleRegistry.setEnabled("managedContent", false);
    const disabled = await app.inject({ method: "GET", url: base, headers });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json().error.code).toBe("MODULE_DISABLED");
  } finally {
    await app.close();
  }
}, 30_000);
