import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ManagedServer, ModHistoryEntry } from "../types.js";

const originalEnv = { ...process.env };
let dataDirectory: string | undefined;
afterEach(async () => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.resetModules();
  if (dataDirectory) await rm(dataDirectory, { recursive: true, force: true });
});

it("records real jar uploads and removals, restores bytes through the API, and enforces permissions and module gates", async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "serversentinel-history-api-"));
  process.env = { ...originalEnv, SS_MODE: "all-in-one", SERVERSENTINEL_DATA_DIR: dataDirectory,
    SERVERSENTINEL_ENABLE_DEMO: "false", SERVERSENTINEL_SERVERS_DOCKER_VOLUME: "", LOG_LEVEL: "silent" };
  vi.resetModules();
  const { buildApp } = await import("../app.js");
  const { services, runtimeForServer } = await import("../appServices.js");
  const app = await buildApp();
  try {
    // Seed an isolated repository fixture; this API test does not use demo mode or account setup.
    const { hashPassword } = await import("../auth/passwords.js");
    const { ALL_PERMISSIONS } = await import("../permissions.js");
    services.usersRepository.create({ id: "history-operator", username: "operator", ...hashPassword("test-password"), rolePreset: "admin",
      permissions: [...ALL_PERMISSIONS], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    const server: ManagedServer = {
      id: "11111111-1111-4111-8111-111111111111", nodeId: "local", displayName: "History test",
      serverDir: join(dataDirectory, "servers", "history-test"), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      runtimeProfile: { runtimeType: "fabric", minecraftVersion: "1.21.4", runtimeVersion: "0.16.10", javaMajorVersion: 21,
        jarProvider: "mcjars", jarArtifact: { filename: "fabric-server-launch.jar", downloadUrl: "https://example.invalid/server.jar" },
        compatibilityStatus: "compatible", resolvedAt: new Date().toISOString() }
    };
    await mkdir(server.serverDir, { recursive: true });
    services.serversRepository.create(server);
    vi.spyOn(runtimeForServer(server), "serverStatus").mockResolvedValue({ running: false });
    const login = await app.inject({ method: "POST", url: "/api/auth/login", headers: { "x-requested-with": "XMLHttpRequest" }, payload: { username: "operator", password: "test-password" } });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers["set-cookie"]).split(";", 1)[0];
    const headers = { cookie, "x-requested-with": "XMLHttpRequest" };
    const base = `/api/servers/${server.id}/mods`;
    expect((await app.inject({ method: "GET", url: `${base}/history`, headers: { "x-requested-with": "XMLHttpRequest" } })).statusCode).toBe(401);
    const bytes = Buffer.from("PK\u0003\u0004my-manually-uploaded-jar");
    const boundary = "history-upload-test";
    const upload = await app.inject({ method: "POST", url: `${base}/upload`, headers: { ...headers, "content-type": `multipart/form-data; boundary=${boundary}` },
      payload: Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${bytes.length}\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="manual.jar"\r\nContent-Type: application/java-archive\r\n\r\n`), bytes, Buffer.from(`\r\n--${boundary}--\r\n`)]) });
    expect(upload.statusCode, upload.body).toBe(200);
    const history = await app.inject({ method: "GET", url: `${base}/history`, headers });
    expect(history.statusCode, history.body).toBe(200);
    const installed = history.json<{ entries: ModHistoryEntry[] }>().entries[0];
    expect(installed).toMatchObject({ action: "installed", user: { username: "operator" }, before: null, after: { filename: "manual.jar", version: null }, canRevert: true });
    expect(history.body).not.toContain("sha1");
    expect((await app.inject({ method: "GET", url: `${base}/history?limit=0`, headers })).statusCode).toBe(400);
    const operatorPermissions = services.storageDatabase.connection.prepare("SELECT permissions_json FROM users WHERE username = 'operator'").get() as { permissions_json: string };
    const setPermissions = (permissions: string[]) => services.storageDatabase.connection.prepare("UPDATE users SET permissions_json = ? WHERE username = 'operator'").run(JSON.stringify(permissions));
    setPermissions(["mods.view", "mods.upload"]);
    const forbidden = await app.inject({ method: "POST", url: `${base}/history/${installed.id}/revert`, headers });
    expect(forbidden.statusCode, forbidden.body).toBe(403);
    expect((await app.inject({ method: "GET", url: `${base}/history`, headers })).json().entries[0].canRevert).toBe(false);
    expect(await readFile(join(server.serverDir, "mods", "manual.jar"))).toEqual(bytes);
    setPermissions(JSON.parse(operatorPermissions.permissions_json));
    const removed = await app.inject({ method: "DELETE", url: `${base}?filename=manual.jar`, headers });
    expect(removed.statusCode, removed.body).toBe(200);
    const deletion = (await app.inject({ method: "GET", url: `${base}/history`, headers })).json().entries[0] as ModHistoryEntry;
    expect(deletion.action).toBe("removed");
    const restored = await app.inject({ method: "POST", url: `${base}/history/${deletion.id}/revert`, headers });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(await readFile(join(server.serverDir, "mods", "manual.jar"))).toEqual(bytes);
    expect((await app.inject({ method: "POST", url: `${base}/history/${deletion.id}/revert`, headers })).statusCode).toBe(409);
    expect((await app.inject({ method: "POST", url: `${base}/history/not-an-entry/revert`, headers })).statusCode).toBe(404);
    const runtime = runtimeForServer(server);
    const listSpy = vi.spyOn(runtime, "listMods").mockRejectedValue(new Error("Node offline"));
    const offline = await app.inject({ method: "GET", url: `${base}/history`, headers });
    expect(offline.statusCode).toBe(200);
    expect(offline.json().entries[0]).toMatchObject({ canRevert: false, revertBlockedReason: "Reconnect the server runtime before reverting." });
    listSpy.mockRestore();
    await services.moduleRegistry.setEnabled("managedContent", false);
    const disabled = await app.inject({ method: "GET", url: `${base}/history`, headers });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json().error.code).toBe("MODULE_DISABLED");
    expect((await app.inject({ method: "POST", url: `${base}/history/${installed.id}/revert`, headers })).statusCode).toBe(403);
  } finally {
    await app.close();
  }
}, 30_000);
