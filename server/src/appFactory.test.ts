import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const temporaryDirectories: string[] = [];

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
      const cookie = login.headers["set-cookie"]?.split(";", 1)[0];
      expect(cookie).toBeTruthy();

      const started = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { cookie, "x-requested-with": "XMLHttpRequest" },
        payload: {}
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
      expect(existsSync(join(dataDir, "exports", `serversentinel-export-${operationId}.json`))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("requires integrations.manage before a server creator can request instance settings", async () => {
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
      const adminCookie = adminLogin.headers["set-cookie"]?.split(";", 1)[0];
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
      const managerCookie = managerLogin.headers["set-cookie"]?.split(";", 1)[0];
      expect(managerCookie).toBeTruthy();
      const payload = {
        artifactBase64: Buffer.from("{}", "utf8").toString("base64"),
        targetNodeId: "local",
        importInstanceSettings: true
      };

      for (const url of ["/api/imports/validate", "/api/imports/apply"]) {
        const response = await app.inject({
          method: "POST",
          url,
          headers: { cookie: managerCookie, "x-requested-with": "XMLHttpRequest" },
          payload
        });
        expect(response.statusCode, response.body).toBe(403);
        expect(response.json()).toEqual({
          error: {
            code: "PERMISSION_DENIED",
            message: "You need permission to manage integrations before performing this action.",
            details: {}
          }
        });
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
      const adminCookie = registered.headers["set-cookie"]?.split(";", 1)[0];
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
        return response.headers["set-cookie"]?.split(";", 1)[0];
      };
      const viewerCookie = await login("viewer");
      const managerCookie = await login("manager");

      const viewerExport = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { ...csrf, cookie: viewerCookie },
        payload: {}
      });
      expect(viewerExport.statusCode).toBe(403);

      const managerInstanceExport = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { ...csrf, cookie: managerCookie },
        payload: { includeInstance: true }
      });
      expect(managerInstanceExport.statusCode).toBe(403);

      const managerExport = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { ...csrf, cookie: managerCookie },
        payload: {}
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
      expect(managerDownload.json()).toMatchObject({
        manifest: { content: { instance: false } },
        instance: { settings: {}, nodes: [] }
      });

      const configured = await app.inject({
        method: "PUT",
        url: "/api/settings/modrinth",
        headers: { ...csrf, cookie: adminCookie },
        payload: { modrinthApiKey: "must-not-be-exported" }
      });
      expect(configured.statusCode, configured.body).toBe(200);

      const adminExport = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { ...csrf, cookie: adminCookie },
        payload: { includeInstance: true }
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
      expect(adminDownload.json().manifest.content.instance).toBe(true);
      expect(adminDownload.json().instance.settings).toEqual({});
      expect(adminDownload.body).not.toContain("must-not-be-exported");

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
});
