import { existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const temporaryDirectories: string[] = [];

function sessionCookieFrom(response: { headers: Record<string, unknown> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" ? value.split(";", 1)[0] : undefined;
}

afterEach(async () => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
  vi.resetModules();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Fastify application factory", () => {
  it("builds without listening and closes against an isolated data directory", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-app-factory-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18081",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const app = await buildApp();

    try {
      expect(app.server.listening).toBe(false);
      expect(app.addresses()).toEqual([]);
      expect(existsSync(join(dataDir, "serversentinel.sqlite"))).toBe(true);
      await expect(buildApp()).rejects.toThrow("Only one serverSENTINEL application instance can be active in a process");
    } finally {
      await app.close();
    }

    expect(app.server.listening).toBe(false);
    const rebuiltApp = await buildApp();
    await rebuiltApp.close();
  });

  it("serves an export artifact to a browser download, which cannot set a request header", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-export-download-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18089",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const app = await buildApp();

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: { "x-requested-with": "XMLHttpRequest" },
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = sessionCookieFrom(login);

      const started = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { cookie, "x-requested-with": "XMLHttpRequest" },
        payload: { selection: { categories: ["serverConfig"], contentStrategy: "lockfile" } }
      });
      expect(started.statusCode, started.body).toBe(200);
      const operationId = started.json().id as string;

      await vi.waitFor(async () => {
        const operation = await app.inject({
          method: "GET",
          url: `/api/operations/${operationId}`,
          headers: { cookie, "x-requested-with": "XMLHttpRequest" }
        });
        expect(operation.json().status, operation.body).toBe("succeeded");
      });

      // The modal links the artifact with a plain anchor so the browser streams a multi-gigabyte
      // archive itself, and a navigation cannot carry `x-requested-with`.
      const download = await app.inject({
        method: "GET",
        url: `/api/exports/${operationId}/download`,
        headers: { cookie }
      });
      expect(download.statusCode, download.body).toBe(200);
      expect(download.headers["content-type"]).toBe("application/zip");
      expect(download.headers["content-disposition"]).toContain("attachment");

      // The exemption is for this artifact alone; the rest of the API still requires the header.
      const operations = await app.inject({ method: "GET", url: "/api/operations", headers: { cookie } });
      expect(operations.statusCode).toBe(400);

      // And it is not an open door: the artifact still needs an authenticated session.
      const anonymous = await app.inject({ method: "GET", url: `/api/exports/${operationId}/download` });
      expect(anonymous.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("queues export preflight failures instead of holding the create request open", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-export-preflight-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18090",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const app = await buildApp();

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: { "x-requested-with": "XMLHttpRequest" },
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = sessionCookieFrom(login);

      // A missing server is a deterministic preflight failure. The create route must still return
      // the operation immediately; real exports may spend much longer traversing a large world.
      const started = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { cookie, "x-requested-with": "XMLHttpRequest" },
        payload: {
          serverIds: ["00000000-0000-4000-8000-000000000001"],
          selection: { categories: ["world"], contentStrategy: "jars" }
        }
      });
      expect(started.statusCode, started.body).toBe(200);
      const operationId = started.json().id as string;

      await vi.waitFor(async () => {
        const operation = await app.inject({
          method: "GET",
          url: `/api/operations/${operationId}`,
          headers: { cookie, "x-requested-with": "XMLHttpRequest" }
        });
        expect(operation.statusCode, operation.body).toBe(200);
        expect(operation.json()).toMatchObject({
          status: "failed",
          errorMessage: "One or more selected servers could not be found"
        });
      });
    } finally {
      await app.close();
    }
  });

  it("refuses downloads after an export artifact expires", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-expired-export-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      SERVERSENTINEL_EXPORT_RETENTION_HOURS: "1",
      LOG_LEVEL: "silent",
      PORT: "18082",
      TZ: "UTC"
    };
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const app = await buildApp();

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: { "x-requested-with": "XMLHttpRequest" },
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = sessionCookieFrom(login);
      expect(cookie).toBeTruthy();

      const started = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { cookie, "x-requested-with": "XMLHttpRequest" },
        payload: { selection: { categories: ["serverConfig"], contentStrategy: "lockfile" } }
      });
      expect(started.statusCode, started.body).toBe(200);
      const operationId = started.json().id as string;

      await vi.waitFor(async () => {
        const operation = await app.inject({
          method: "GET",
          url: `/api/operations/${operationId}`,
          headers: { cookie, "x-requested-with": "XMLHttpRequest" }
        });
        expect(operation.json().status, operation.body).toBe("succeeded");
      });

      const available = await app.inject({
        method: "GET",
        url: `/api/exports/${operationId}/download`,
        headers: { cookie, "x-requested-with": "XMLHttpRequest" }
      });
      expect(available.statusCode).toBe(200);

      now += 60 * 60 * 1000 + 1;
      const expired = await app.inject({
        method: "GET",
        url: `/api/exports/${operationId}/download`,
        headers: { cookie, "x-requested-with": "XMLHttpRequest" }
      });
      expect(expired.statusCode).toBe(410);
      expect(expired.json()).toEqual({
        error: { code: "EXPORT_EXPIRED", message: "Export artifact has expired", details: {} }
      });
      expect(existsSync(join(dataDir, "exports", `serversentinel-export-${operationId}.zip`))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("requires integrations.manage before a server creator can change instance settings", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-import-permissions-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18083",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const app = await buildApp();

    try {
      const adminLogin = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: { "x-requested-with": "XMLHttpRequest" },
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(adminLogin.statusCode, adminLogin.body).toBe(200);
      const adminCookie = sessionCookieFrom(adminLogin);
      expect(adminCookie).toBeTruthy();

      const configured = await app.inject({
        method: "PUT",
        url: "/api/settings/modrinth",
        headers: { cookie: adminCookie, "x-requested-with": "XMLHttpRequest" },
        payload: { modrinthApiKey: "destination-key" }
      });
      expect(configured.statusCode, configured.body).toBe(200);

      const manager = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { cookie: adminCookie, "x-requested-with": "XMLHttpRequest" },
        payload: { username: "manager", password: "password123", rolePreset: "manager" }
      });
      expect(manager.statusCode, manager.body).toBe(200);
      expect(manager.json().permissions).toContain("servers.create");
      expect(manager.json().permissions).not.toContain("integrations.manage");

      const managerLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { "x-requested-with": "XMLHttpRequest" },
        payload: { username: "manager", password: "password123" }
      });
      expect(managerLogin.statusCode, managerLogin.body).toBe(200);
      const managerCookie = sessionCookieFrom(managerLogin);
      expect(managerCookie).toBeTruthy();
      for (const request of [
        { method: "PUT" as const, url: "/api/settings/player-heads", payload: { enabled: true } },
        { method: "DELETE" as const, url: "/api/settings/player-heads/cache", payload: undefined }
      ]) {
        const response = await app.inject({
          method: request.method,
          url: request.url,
          headers: { cookie: managerCookie, "x-requested-with": "XMLHttpRequest" },
          payload: request.payload
        });
        expect(response.statusCode, response.body).toBe(403);
      }
    } finally {
      await app.close();
    }

    const database = new Database(join(dataDir, "serversentinel.sqlite"), { readonly: true });
    try {
      const row = database.prepare("SELECT modrinth_api_key FROM app_settings WHERE id = 1").get() as { modrinth_api_key?: string } | undefined;
      expect(row?.modrinth_api_key).toBe("destination-key");
    } finally {
      database.close();
    }
  });

  it("persists the player-head privacy choice and exposes no onboarding prompt after restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-player-head-settings-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18084",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    let app = await buildApp();
    const csrf = { "x-requested-with": "XMLHttpRequest" };

    const browserImageRequest = await app.inject({
      method: "GET",
      url: "/api/servers/server-1/player-head/Alex?v=123"
    });
    expect(browserImageRequest.statusCode, browserImageRequest.body).toBe(401);
    expect(browserImageRequest.body).not.toContain("CSRF protection");

    const ordinaryHeaderlessApiRequest = await app.inject({ method: "GET", url: "/api/app" });
    expect(ordinaryHeaderlessApiRequest.statusCode, ordinaryHeaderlessApiRequest.body).toBe(400);
    expect(ordinaryHeaderlessApiRequest.body).toContain("CSRF protection");

    const registered = await app.inject({
      method: "POST",
      url: "/api/auth/register-first",
      headers: csrf,
      payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
    });
    expect(registered.statusCode, registered.body).toBe(200);
    const cookie = sessionCookieFrom(registered);
    expect(cookie).toBeTruthy();

    const initial = await app.inject({ method: "GET", url: "/api/app", headers: { ...csrf, cookie } });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json().playerHeads).toEqual({
      enabled: false,
      onboardingRequired: true,
      provider: "mc-heads.net",
      cacheEntries: 0,
      cacheBytes: 0
    });

    const enabled = await app.inject({
      method: "PUT",
      url: "/api/settings/player-heads",
      headers: { ...csrf, cookie },
      payload: { enabled: true }
    });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(enabled.json().playerHeads).toMatchObject({ enabled: true, onboardingRequired: false });
    await app.close();

    app = await buildApp();
    try {
      const persisted = await app.inject({ method: "GET", url: "/api/app", headers: { ...csrf, cookie } });
      expect(persisted.statusCode, persisted.body).toBe(200);
      expect(persisted.json().playerHeads).toMatchObject({ enabled: true, onboardingRequired: false });

      const cleared = await app.inject({
        method: "DELETE",
        url: "/api/settings/player-heads/cache",
        headers: { ...csrf, cookie }
      });
      expect(cleared.statusCode, cleared.body).toBe(200);
      expect(cleared.json().playerHeads).toMatchObject({ cacheEntries: 0, cacheBytes: 0 });
    } finally {
      await app.close();
    }
  });

  it("enforces Viewer, Manager, and Admin export boundaries without serializing credentials", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-export-authorization-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18083",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const app = await buildApp();
    const csrf = { "x-requested-with": "XMLHttpRequest" };

    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: csrf,
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(registered.statusCode, registered.body).toBe(200);
      const adminCookie = sessionCookieFrom(registered);
      expect(adminCookie).toBeTruthy();

      for (const rolePreset of ["viewer", "manager"] as const) {
        const created = await app.inject({
          method: "POST",
          url: "/api/users",
          headers: { ...csrf, cookie: adminCookie },
          payload: { username: rolePreset, password: "password123", rolePreset }
        });
        expect(created.statusCode, created.body).toBe(200);
      }

      const login = async (username: string) => {
        const response = await app.inject({
          method: "POST",
          url: "/api/auth/login",
          headers: csrf,
          payload: { username, password: "password123" }
        });
        expect(response.statusCode, response.body).toBe(200);
        return sessionCookieFrom(response);
      };
      const viewerCookie = await login("viewer");
      const managerCookie = await login("manager");

      const selection = { categories: ["serverConfig"], contentStrategy: "lockfile" };

      const viewerExport = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { ...csrf, cookie: viewerCookie },
        payload: { selection }
      });
      expect(viewerExport.statusCode).toBe(403);

      const managerExport = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { ...csrf, cookie: managerCookie },
        payload: { selection }
      });
      expect(managerExport.statusCode, managerExport.body).toBe(200);
      const managerOperationId = managerExport.json().id as string;

      await vi.waitFor(async () => {
        const operation = await app.inject({
          method: "GET",
          url: `/api/operations/${managerOperationId}`,
          headers: { ...csrf, cookie: managerCookie }
        });
        expect(operation.json().status, operation.body).toBe("succeeded");
      });
      const managerDownload = await app.inject({
        method: "GET",
        url: `/api/exports/${managerOperationId}/download`,
        headers: { ...csrf, cookie: managerCookie }
      });
      expect(managerDownload.statusCode, managerDownload.body).toBe(200);
      expect(managerDownload.headers["content-type"]).toBe("application/zip");
      expect(managerDownload.rawPayload.subarray(0, 2).toString("latin1")).toBe("PK");

      const configured = await app.inject({
        method: "PUT",
        url: "/api/settings/modrinth",
        headers: { ...csrf, cookie: adminCookie },
        payload: { modrinthApiKey: "must-not-be-exported" }
      });
      expect(configured.statusCode, configured.body).toBe(200);
      const playerHeadsConfigured = await app.inject({
        method: "PUT",
        url: "/api/settings/player-heads",
        headers: { ...csrf, cookie: adminCookie },
        payload: { enabled: true }
      });
      expect(playerHeadsConfigured.statusCode, playerHeadsConfigured.body).toBe(200);

      const adminExport = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { ...csrf, cookie: adminCookie },
        payload: { selection: { categories: ["serverConfig", "panelSettings"], contentStrategy: "lockfile" } }
      });
      expect(adminExport.statusCode, adminExport.body).toBe(200);
      const adminOperationId = adminExport.json().id as string;

      await vi.waitFor(async () => {
        const operation = await app.inject({
          method: "GET",
          url: `/api/operations/${adminOperationId}`,
          headers: { ...csrf, cookie: adminCookie }
        });
        expect(operation.json().status, operation.body).toBe("succeeded");
      });
      const adminDownload = await app.inject({
        method: "GET",
        url: `/api/exports/${adminOperationId}/download`,
        headers: { ...csrf, cookie: adminCookie }
      });
      expect(adminDownload.statusCode, adminDownload.body).toBe(200);
      expect(adminDownload.rawPayload.subarray(0, 2).toString("latin1")).toBe("PK");
      // Instance settings never enter the artifact, so no credential can reach it in any category.
      expect(adminDownload.rawPayload.toString("latin1")).not.toContain("must-not-be-exported");
      expect(adminDownload.rawPayload.toString("latin1")).not.toContain("player_heads_enabled");

      const crossUserDownload = await app.inject({
        method: "GET",
        url: `/api/exports/${adminOperationId}/download`,
        headers: { ...csrf, cookie: managerCookie }
      });
      expect(crossUserDownload.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("requires servers.view before serving the runtime and version catalogs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-version-catalog-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18084",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const app = await buildApp();
    const csrf = { "x-requested-with": "XMLHttpRequest" };
    const catalogUrls = [
      "/api/runtime/types",
      "/api/runtime/fabric/minecraft-versions",
      "/api/runtime/fabric/versions?minecraftVersion=1.21.4"
    ];

    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: csrf,
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(registered.statusCode, registered.body).toBe(200);
      const adminCookie = sessionCookieFrom(registered);

      // console.view expands to itself only, so this account is authenticated
      // but holds none of the server permissions the catalogs gate on.
      const created = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { ...csrf, cookie: adminCookie },
        payload: { username: "console-only", password: "password123", permissions: ["console.view"] }
      });
      expect(created.statusCode, created.body).toBe(200);
      expect(created.json().permissions).toEqual(["console.view"]);

      const login = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: csrf,
        payload: { username: "console-only", password: "password123" }
      });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = sessionCookieFrom(login);

      for (const url of catalogUrls) {
        const response = await app.inject({ method: "GET", url, headers: { ...csrf, cookie } });
        expect(response.statusCode, `${url} -> ${response.body}`).toBe(403);
        expect(response.json().error.code).toBe("PERMISSION_DENIED");
      }

      for (const url of catalogUrls) {
        const response = await app.inject({ method: "GET", url, headers: { ...csrf } });
        expect(response.statusCode, `${url} -> ${response.body}`).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it("compresses JSON replies but leaves the export artifact download intact", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-compression-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18086",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const app = await buildApp();
    const csrf = { "x-requested-with": "XMLHttpRequest" };

    try {
      const register = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: csrf,
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(register.statusCode, register.body).toBe(200);
      const cookie = sessionCookieFrom(register);

      // Each user carries the full permission list, so a handful of them puts the reply
      // comfortably past the compression threshold without depending on a built frontend.
      for (const username of ["operator", "maintainer", "viewer"]) {
        const created = await app.inject({
          method: "POST",
          url: "/api/users",
          headers: { ...csrf, cookie },
          payload: { username, password: "password123", rolePreset: "maintainer" }
        });
        expect(created.statusCode, created.body).toBe(200);
      }

      const identity = await app.inject({ method: "GET", url: "/api/users", headers: { ...csrf, cookie } });
      expect(identity.statusCode, identity.body).toBe(200);
      expect(identity.rawPayload.length).toBeGreaterThan(1024);
      expect(identity.headers["content-encoding"]).toBeUndefined();

      const compressed = await app.inject({
        method: "GET",
        url: "/api/users",
        headers: { ...csrf, cookie, "accept-encoding": "gzip" }
      });
      expect(compressed.statusCode).toBe(200);
      expect(compressed.headers["content-encoding"]).toBe("gzip");
      expect(compressed.headers.vary).toContain("accept-encoding");
      expect(compressed.rawPayload.length).toBeLessThan(identity.rawPayload.length);
      expect(gunzipSync(compressed.rawPayload).toString("utf8")).toBe(identity.body);

      const started = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { ...csrf, cookie },
        payload: { selection: { categories: ["serverConfig"], contentStrategy: "lockfile" } }
      });
      expect(started.statusCode, started.body).toBe(200);
      const operationId = started.json().id as string;
      await vi.waitFor(async () => {
        const operation = await app.inject({ method: "GET", url: `/api/operations/${operationId}`, headers: { ...csrf, cookie } });
        expect(operation.json().status, operation.body).toBe("succeeded");
      });

      // Only the route-level opt-out keeps the artifact's Content-Length -- and with it the size the
      // browser's download UI reports for a file that can reach many gigabytes. Re-compressing an
      // already-deflated ZIP would cost CPU for nothing and drop that header.
      const download = await app.inject({
        method: "GET",
        url: `/api/exports/${operationId}/download`,
        headers: { ...csrf, cookie, "accept-encoding": "gzip" }
      });
      expect(download.statusCode).toBe(200);
      expect(download.headers["content-encoding"]).toBeUndefined();
      expect(download.headers["content-length"]).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
