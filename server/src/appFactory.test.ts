import { existsSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedServer } from "./types.js";

const originalEnv = { ...process.env };
const temporaryDirectories: string[] = [];

function sessionCookieFrom(response: { headers: Record<string, unknown> }) {
  const header = response.headers["set-cookie"];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" ? value.split(";", 1)[0] : undefined;
}

function multipartChunk(offset: number, content: Buffer) {
  const boundary = `serversentinel-test-${offset}`;
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    payload: Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="offset"\r\n\r\n${offset}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="export.zip"\r\nContent-Type: application/zip\r\n\r\n`),
      content,
      Buffer.from(`\r\n--${boundary}--\r\n`)
    ])
  };
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

  it("persists node update notification settings through the node API", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-node-notifications-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18093",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const app = await buildApp();
    const csrf = { "x-requested-with": "XMLHttpRequest" };

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: csrf,
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = sessionCookieFrom(login);
      const created = await app.inject({
        method: "POST",
        url: "/api/nodes",
        headers: { ...csrf, cookie },
        payload: { name: "Update test node" }
      });
      expect(created.statusCode, created.body).toBe(200);
      const nodeId = created.json().node.id as string;
      expect(created.json().node.updateNotificationsEnabled).toBe(true);

      const disabled = await app.inject({
        method: "PUT",
        url: `/api/nodes/${nodeId}/update-notifications`,
        headers: { ...csrf, cookie },
        payload: { enabled: false }
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(disabled.json().node.updateNotificationsEnabled).toBe(false);

      const listed = await app.inject({ method: "GET", url: "/api/nodes", headers: { ...csrf, cookie } });
      expect(listed.statusCode, listed.body).toBe(200);
      expect(listed.json().nodes).toContainEqual(expect.objectContaining({
        id: nodeId,
        updateNotificationsEnabled: false
      }));
    } finally {
      await app.close();
    }
  });

  it("assembles an import archive from bounded multipart chunks", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-chunked-import-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18092",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const app = await buildApp();
    const csrf = { "x-requested-with": "XMLHttpRequest" };

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: csrf,
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(login.statusCode, login.body).toBe(200);
      const cookie = sessionCookieFrom(login);
      const expected = Buffer.from("chunk-one-chunk-two");

      const created = await app.inject({
        method: "POST",
        url: "/api/imports/uploads",
        headers: { ...csrf, cookie },
        payload: { size: expected.length }
      });
      expect(created.statusCode, created.body).toBe(201);
      expect(created.json().chunkSize).toBe(16 * 1024 * 1024);
      const importId = created.json().importId as string;

      let offset = 0;
      for (const content of [Buffer.from("chunk-one-"), Buffer.from("chunk-two")]) {
        const chunk = multipartChunk(offset, content);
        const uploaded = await app.inject({
          method: "POST",
          url: `/api/imports/${importId}/chunks`,
          headers: { ...csrf, cookie, "content-type": chunk.contentType },
          payload: chunk.payload
        });
        offset += content.length;
        expect(uploaded.statusCode, uploaded.body).toBe(200);
        expect(uploaded.json().received).toBe(offset);
      }

      const completed = await app.inject({
        method: "POST",
        url: `/api/imports/${importId}/complete`,
        headers: { ...csrf, cookie },
        payload: { size: expected.length }
      });
      expect(completed.statusCode, completed.body).toBe(200);
      expect(await readFile(join(dataDir, "imports", `import-${importId}.zip`))).toEqual(expected);
    } finally {
      await app.close();
    }
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
      expect(started.statusCode, started.body).toBe(202);
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

      const artifactPath = join(dataDir, "exports", `serversentinel-export-${operationId}.zip`);
      expect(existsSync(artifactPath)).toBe(true);
      const deleted = await app.inject({
        method: "DELETE",
        url: `/api/exports/${operationId}`,
        headers: { cookie, "x-requested-with": "XMLHttpRequest" }
      });
      expect(deleted.statusCode, deleted.body).toBe(200);
      expect(deleted.json()).toEqual({ ok: true });
      expect(existsSync(artifactPath)).toBe(false);

      const deletedDownload = await app.inject({
        method: "GET",
        url: `/api/exports/${operationId}/download`,
        headers: { cookie }
      });
      expect(deletedDownload.statusCode).toBe(404);

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
      expect(started.statusCode, started.body).toBe(202);
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

  it("retains successful export downloads indefinitely", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-expired-export-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
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
      expect(started.statusCode, started.body).toBe(202);
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
      const retained = await app.inject({
        method: "GET",
        url: `/api/exports/${operationId}/download`,
        headers: { cookie, "x-requested-with": "XMLHttpRequest" }
      });
      expect(retained.statusCode).toBe(200);
      expect(existsSync(join(dataDir, "exports", `serversentinel-export-${operationId}.zip`))).toBe(true);
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
      expect(managerExport.statusCode, managerExport.body).toBe(202);
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
      expect(adminExport.statusCode, adminExport.body).toBe(202);
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

      const crossUserDelete = await app.inject({
        method: "DELETE",
        url: `/api/exports/${adminOperationId}`,
        headers: { ...csrf, cookie: managerCookie }
      });
      expect(crossUserDelete.statusCode).toBe(404);

      const retainedAdminDownload = await app.inject({
        method: "GET",
        url: `/api/exports/${adminOperationId}/download`,
        headers: { ...csrf, cookie: adminCookie }
      });
      expect(retainedAdminDownload.statusCode).toBe(200);
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

  it("shows an active export per server and blocks only server mutations", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-export-locks-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "all-in-one",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18091",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const { services } = await import("./appServices.js");
    const app = await buildApp();
    const csrf = { "x-requested-with": "XMLHttpRequest" };
    const serverDir = join(dataDir, "servers", "server-1");
    await mkdir(serverDir, { recursive: true });
    const now = "2026-01-01T00:00:00.000Z";
    const server: ManagedServer = {
      id: "11111111-1111-4111-8111-111111111111",
      nodeId: "local",
      displayName: "Survival",
      serverDir,
      storageName: "11111111-1111-4111-8111-111111111111",
      runtimeProfile: {
        minecraftVersion: "1.21.4",
        runtimeType: "fabric",
        runtimeVersion: "0.16.10",
        javaMajorVersion: 21,
        jarProvider: "mcjars",
        jarArtifact: { filename: "fabric-server-launch.jar" },
        compatibilityStatus: "compatible",
        resolvedAt: now
      },
      dockerContainer: "survival",
      dockerPorts: "25565:25565/tcp",
      javaArgs: "-Xms2G -Xmx4G",
      startOnNodeStart: false,
      runtimeIntent: "stopped",
      schedules: [{
        id: "22222222-2222-4222-8222-222222222222",
        name: "Hourly notice",
        cron: "0 * * * *",
        steps: [{ type: "command", command: "say hello", delaySeconds: 0 }],
        onlyWhenNoPlayers: false,
        waitForPlayersToLeave: false,
        enabled: true,
        createdAt: now,
        updatedAt: now,
        recentRuns: []
      }],
      createdAt: now,
      updatedAt: now
    };
    services.serversRepository.create(server);

    let releaseExport!: () => void;
    let lockedExport: Promise<void> | undefined;
    let operationId = "";
    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: csrf,
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(registered.statusCode, registered.body).toBe(200);
      const cookie = sessionCookieFrom(registered);
      const admin = services.usersRepository.list().find((user) => user.username === "admin")!;
      const managerCreated = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { ...csrf, cookie },
        payload: { username: "manager", password: "password123", rolePreset: "manager" }
      });
      expect(managerCreated.statusCode, managerCreated.body).toBe(200);
      const managerLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: csrf,
        payload: { username: "manager", password: "password123" }
      });
      expect(managerLogin.statusCode, managerLogin.body).toBe(200);
      const managerCookie = sessionCookieFrom(managerLogin);

      const retained = services.operationsRepository.create({ type: "export.run", createdBy: admin.id, task: "Export ready", progress: 100 });
      const retainedPath = join(dataDir, "exports", `serversentinel-export-${retained.id}.zip`);
      await mkdir(join(dataDir, "exports"), { recursive: true });
      await writeFile(retainedPath, "retained export");
      services.operationsRepository.start(retained.id);
      services.operationsRepository.succeed(retained.id, {
        task: "Export ready",
        progress: 100,
        result: {
          serverIds: [server.id],
          selection: { categories: ["serverConfig"], contentStrategy: "lockfile" },
          artifactPath: retainedPath,
          artifact: { filename: `serversentinel-export-${retained.id}.zip`, size: 15, downloadUrl: `/api/exports/${retained.id}/download` }
        }
      });
      const operation = services.operationsRepository.create({ type: "export.run", createdBy: admin.id, task: "Compressing world", progress: 42 });
      operationId = operation.id;
      services.operationsRepository.start(operation.id, { task: "Compressing world", progress: 42 });
      services.operationsRepository.replaceResult(operation.id, {
        serverIds: [server.id],
        selection: { categories: ["world"], contentStrategy: "lockfile" }
      });
      lockedExport = services.exportCoordinator.run(operation.id, [server.id], () => new Promise<void>((resolve) => { releaseExport = resolve; }));

      const state = await app.inject({ method: "GET", url: `/api/servers/${server.id}/exports`, headers: { ...csrf, cookie } });
      expect(state.statusCode, state.body).toBe(200);
      expect(state.json()).toMatchObject({
        latest: { id: operation.id, status: "running", progress: 42, task: "Compressing world", canCancel: true },
        artifact: { operationId: retained.id, downloadUrl: `/api/exports/${retained.id}/download` }
      });
      const sharedState = await app.inject({ method: "GET", url: `/api/servers/${server.id}/exports`, headers: { ...csrf, cookie: managerCookie } });
      expect(sharedState.statusCode, sharedState.body).toBe(200);
      expect(sharedState.json()).toMatchObject({
        latest: { id: operation.id, status: "running", progress: 42, canCancel: false },
        artifact: { operationId: retained.id }
      });
      expect(sharedState.json().artifact).not.toHaveProperty("downloadUrl");

      for (const request of [
        { method: "PUT", url: `/api/servers/${server.id}`, payload: { displayName: "Renamed" } },
        { method: "DELETE", url: `/api/servers/${server.id}`, payload: { confirmName: server.displayName, deleteFiles: false } },
        { method: "POST", url: `/api/servers/${server.id}/start`, payload: {} },
        { method: "POST", url: `/api/servers/${server.id}/command`, payload: { command: "say hello" } },
        { method: "POST", url: `/api/servers/${server.id}/folder`, payload: { path: ".", name: "blocked" } },
        { method: "POST", url: `/api/servers/${server.id}/files/archive/extract`, payload: { path: "missing.zip", destinationPath: ".", conflictPolicy: "replace" } },
        { method: "PATCH", url: `/api/servers/${server.id}/mods`, payload: { filename: "example.jar", enabled: false } },
        { method: "POST", url: `/api/servers/${server.id}/schedules`, payload: { name: "Blocked", cron: "0 * * * *", steps: [{ type: "command", command: "say blocked", delaySeconds: 0 }], enabled: true } },
        { method: "POST", url: `/api/servers/${server.id}/schedules/22222222-2222-4222-8222-222222222222/run`, payload: {} }
      ] as const) {
        const response = await app.inject({ ...request, headers: { ...csrf, cookie } });
        expect(response.statusCode, `${request.method} ${request.url}: ${response.body}`).toBe(409);
        expect(response.json().error.code).toBe("EXPORT_IN_PROGRESS");
      }

      const overlapping = await app.inject({
        method: "POST",
        url: "/api/exports",
        headers: { ...csrf, cookie },
        payload: { serverIds: [server.id], selection: { categories: ["serverConfig"], contentStrategy: "lockfile" } }
      });
      expect(overlapping.statusCode, overlapping.body).toBe(409);
      expect(overlapping.json().error.code).toBe("EXPORT_ALREADY_RUNNING");

      const files = await app.inject({ method: "GET", url: `/api/servers/${server.id}/files?path=.`, headers: { ...csrf, cookie } });
      const schedules = await app.inject({ method: "GET", url: `/api/servers/${server.id}/schedules`, headers: { ...csrf, cookie } });
      expect(files.statusCode, files.body).toBe(200);
      expect(schedules.statusCode, schedules.body).toBe(200);
    } finally {
      releaseExport?.();
      await lockedExport;
      if (operationId) services.operationsRepository.cancel(operationId, "Test complete");
      await app.close();
    }
  });

  it("rejects every start path for an imported server with an unresolved port conflict", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-import-port-guard-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "all-in-one",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18094",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const { services } = await import("./appServices.js");
    const app = await buildApp();
    const csrf = { "x-requested-with": "XMLHttpRequest" };
    const now = "2026-01-01T00:00:00.000Z";
    const profile: ManagedServer["runtimeProfile"] = {
      minecraftVersion: "1.21.4",
      runtimeType: "fabric",
      runtimeVersion: "0.16.10",
      javaMajorVersion: 21,
      jarProvider: "mcjars",
      jarArtifact: { filename: "fabric-server-launch.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: now
    };
    const existing: ManagedServer = {
      id: "11111111-1111-4111-8111-111111111111",
      nodeId: "local",
      displayName: "Survival",
      serverDir: join(dataDir, "servers", "existing"),
      runtimeProfile: profile,
      dockerPorts: "25565:25565/tcp",
      runtimeIntent: "stopped",
      createdAt: now,
      updatedAt: now
    };
    const imported: ManagedServer = {
      ...existing,
      id: "22222222-2222-4222-8222-222222222222",
      displayName: "Imported Survival",
      serverDir: join(dataDir, "servers", "imported"),
      portConflictUnresolved: true
    };
    services.serversRepository.create(existing);
    services.serversRepository.create(imported);

    try {
      const login = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: csrf,
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      const cookie = sessionCookieFrom(login);
      const response = await app.inject({
        method: "POST",
        url: `/api/servers/${imported.id}/start`,
        headers: { ...csrf, cookie },
        payload: {}
      });

      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error).toMatchObject({
        code: "PORT_CONFLICT",
        message: expect.stringContaining('25565/tcp is already used on this node by "Survival"')
      });
      expect(services.serversRepository.find(imported.id)?.runtimeIntent).toBe("stopped");
    } finally {
      await app.close();
    }
  });

  it("switches an optional module off for the whole installation and keeps it off across restarts", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-modules-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18095",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    let app = await buildApp();
    const csrf = { "x-requested-with": "XMLHttpRequest" };
    const scheduleUrl = "/api/servers/11111111-1111-4111-8111-111111111111/schedules";
    const modsUrl = "/api/servers/11111111-1111-4111-8111-111111111111/mods";

    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: csrf,
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(registered.statusCode, registered.body).toBe(200);
      const adminCookie = sessionCookieFrom(registered);

      const initial = await app.inject({ method: "GET", url: "/api/app", headers: { ...csrf, cookie: adminCookie } });
      expect(initial.statusCode, initial.body).toBe(200);
      expect(initial.json().modules).toEqual([
        { id: "schedules", enabled: true, accessible: true },
        { id: "managedContent", enabled: true, accessible: true },
        { id: "playerInsights", enabled: true, accessible: true }
      ]);

      // An account without schedules.view sees the module as present but out of reach, which is
      // what keeps the browser from fetching its code for them.
      const viewerCreated = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { ...csrf, cookie: adminCookie },
        payload: { username: "console-only", password: "password123", permissions: ["servers.view", "settings.view"] }
      });
      expect(viewerCreated.statusCode, viewerCreated.body).toBe(200);
      const viewerLogin = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: csrf,
        payload: { username: "console-only", password: "password123" }
      });
      const viewerCookie = sessionCookieFrom(viewerLogin);
      const viewerApp = await app.inject({ method: "GET", url: "/api/app", headers: { ...csrf, cookie: viewerCookie } });
      expect(viewerApp.json().modules).toEqual([
        { id: "schedules", enabled: true, accessible: false },
        { id: "managedContent", enabled: true, accessible: false },
        { id: "playerInsights", enabled: true, accessible: false }
      ]);

      // Reading the catalog is a settings-level right; changing it is not.
      expect((await app.inject({ method: "GET", url: "/api/modules", headers: { ...csrf, cookie: viewerCookie } })).statusCode).toBe(200);
      const refusedToggle = await app.inject({
        method: "PUT",
        url: "/api/modules/schedules",
        headers: { ...csrf, cookie: viewerCookie },
        payload: { enabled: false }
      });
      expect(refusedToggle.statusCode, refusedToggle.body).toBe(403);

      const disabled = await app.inject({
        method: "PUT",
        url: "/api/modules/schedules",
        headers: { ...csrf, cookie: adminCookie },
        payload: { enabled: false }
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(disabled.json().modules).toEqual([
        { id: "schedules", enabled: false, accessible: false },
        { id: "managedContent", enabled: true, accessible: true },
        { id: "playerInsights", enabled: true, accessible: true }
      ]);

      const refused = await app.inject({ method: "GET", url: scheduleUrl, headers: { ...csrf, cookie: adminCookie } });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json().error.code).toBe("MODULE_DISABLED");

      // Modules are independent: switching one off leaves the other one's endpoints answering.
      const otherModule = await app.inject({ method: "GET", url: modsUrl, headers: { ...csrf, cookie: adminCookie } });
      expect(otherModule.json().error?.code).not.toBe("MODULE_DISABLED");

      const afterDisable = await app.inject({ method: "GET", url: "/api/app", headers: { ...csrf, cookie: adminCookie } });
      expect(afterDisable.json().modules).toEqual([
        { id: "schedules", enabled: false, accessible: false },
        { id: "managedContent", enabled: true, accessible: true },
        { id: "playerInsights", enabled: true, accessible: true }
      ]);
      await app.close();

      app = await buildApp();
      const restarted = await app.inject({ method: "GET", url: scheduleUrl, headers: { ...csrf, cookie: adminCookie } });
      expect(restarted.statusCode, restarted.body).toBe(403);
      expect(restarted.json().error.code).toBe("MODULE_DISABLED");

      const reEnabled = await app.inject({
        method: "PUT",
        url: "/api/modules/schedules",
        headers: { ...csrf, cookie: adminCookie },
        payload: { enabled: true }
      });
      expect(reEnabled.statusCode, reEnabled.body).toBe(200);
      const reachable = await app.inject({ method: "GET", url: scheduleUrl, headers: { ...csrf, cookie: adminCookie } });
      expect(reachable.json().error?.code).not.toBe("MODULE_DISABLED");
    } finally {
      await app.close();
    }
  });

  it("stops the managed content module's update checker and endpoints without touching installed content", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-managed-content-module-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18096",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const { services } = await import("./appServices.js");
    let app = await buildApp();
    const csrf = { "x-requested-with": "XMLHttpRequest" };
    const serverId = "11111111-1111-4111-8111-111111111111";
    const contentDirectory = join(dataDir, "servers", "survival", "mods");
    await mkdir(contentDirectory, { recursive: true });
    const installedJar = join(contentDirectory, "example-mod.jar");
    await writeFile(installedJar, "installed content");

    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: csrf,
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(registered.statusCode, registered.body).toBe(200);
      const cookie = sessionCookieFrom(registered);

      // The hourly update check is the module's background work, and it only exists while the
      // module does: nothing builds it at boot when the module is off.
      expect(services.modUpdatePlanCoordinator).toBeDefined();

      const disabled = await app.inject({
        method: "PUT",
        url: "/api/modules/managedContent",
        headers: { ...csrf, cookie },
        payload: { enabled: false }
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(services.modUpdatePlanCoordinator).toBeUndefined();

      for (const url of [
        `/api/servers/${serverId}/mods`,
        `/api/servers/${serverId}/mods/update-plan`,
        "/api/modrinth/search?query=sodium"
      ]) {
        const response = await app.inject({ method: "GET", url, headers: { ...csrf, cookie } });
        expect(response.statusCode, `${url} -> ${response.body}`).toBe(403);
        expect(response.json().error.code).toBe("MODULE_DISABLED");
      }

      // Installing is refused by the same guard, before any handler could touch the filesystem.
      const install = await app.inject({
        method: "POST",
        url: "/api/modrinth/install",
        headers: { ...csrf, cookie },
        payload: { serverId, projectId: "AANobbMI", versionId: "abcdefgh" }
      });
      expect(install.statusCode, install.body).toBe(403);
      expect(install.json().error.code).toBe("MODULE_DISABLED");

      await app.close();
      app = await buildApp();
      const { services: restartedServices } = await import("./appServices.js");
      expect(restartedServices.modUpdatePlanCoordinator).toBeUndefined();

      const stillRefused = await app.inject({ method: "GET", url: `/api/servers/${serverId}/mods`, headers: { ...csrf, cookie } });
      expect(stillRefused.json().error.code).toBe("MODULE_DISABLED");

      const reEnabled = await app.inject({
        method: "PUT",
        url: "/api/modules/managedContent",
        headers: { ...csrf, cookie },
        payload: { enabled: true }
      });
      expect(reEnabled.statusCode, reEnabled.body).toBe(200);
      expect(restartedServices.modUpdatePlanCoordinator).toBeDefined();

      const reachable = await app.inject({ method: "GET", url: `/api/servers/${serverId}/mods`, headers: { ...csrf, cookie } });
      expect(reachable.json().error?.code).not.toBe("MODULE_DISABLED");

      // Switching the module off is not an uninstall: what a server has on disk is left alone.
      expect(await readFile(installedJar, "utf8")).toBe("installed content");
    } finally {
      await app.close();
    }
  });

  it("stops every part of Player Insights when the module is switched off, and keeps the geography it derived", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "serversentinel-player-insights-module-"));
    temporaryDirectories.push(dataDir);
    process.env = {
      ...originalEnv,
      SS_MODE: "panel",
      SERVERSENTINEL_DATA_DIR: dataDir,
      SERVERSENTINEL_ENABLE_DEMO: "false",
      SERVERSENTINEL_TRUST_PROXY: "false",
      SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef",
      LOG_LEVEL: "silent",
      PORT: "18097",
      TZ: "UTC"
    };
    vi.resetModules();
    const { buildApp } = await import("./app.js");
    const { services } = await import("./appServices.js");
    let app = await buildApp();
    const csrf = { "x-requested-with": "XMLHttpRequest" };
    const insightsUrl = "/api/players/insights";

    try {
      const registered = await app.inject({
        method: "POST",
        url: "/api/auth/register-first",
        headers: csrf,
        payload: { username: "admin", password: "password123", setupToken: "0123456789abcdef" }
      });
      expect(registered.statusCode, registered.body).toBe(200);
      const cookie = sessionCookieFrom(registered);

      // The database and the collector are the module's whole exposure to a player's address, and
      // they exist only while the module does.
      expect(services.playerGeoDatabase).toBeDefined();
      expect(services.playerGeoCollector).toBeDefined();

      const insights = await app.inject({ method: "GET", url: insightsUrl, headers: { ...csrf, cookie } });
      expect(insights.statusCode, insights.body).toBe(200);
      expect(insights.json().attribution).toContain("MaxMind");
      // Nothing was configured, so the panel says it has no database rather than pretending to.
      expect(insights.json().geoDatabase).toMatchObject({ available: false, configured: false });
      expect(insights.json().summary).toMatchObject({ countries: 0, knownPlayers: 0 });

      // Something the module derived earlier, which must survive being switched off.
      services.storageDatabase.connection.prepare("INSERT INTO nodes (id, name, type, status, is_internal, created_at, updated_at) VALUES ('node-1', 'Node', 'remote', 'online', 0, '2026-01-01', '2026-01-01')").run();
      services.storageDatabase.connection.prepare(`
        INSERT INTO servers (id, node_id, display_name, server_dir, runtime_profile_json, created_at, updated_at)
        VALUES ('11111111-1111-4111-8111-111111111111', 'node-1', 'Survival', '/servers/survival', '{}', '2026-01-01', '2026-01-01')
      `).run();
      services.playerGeoRepository.record({
        serverId: "11111111-1111-4111-8111-111111111111",
        player: "SullyTheSnak",
        location: { label: "Copenhagen", countryCode: "DK", continentCode: "EU", latitude: 55.68, longitude: 12.57, precision: "city" },
        at: Date.now()
      });
      expect(services.playerGeoRepository.stats().entries).toBe(1);

      const withoutPermission = await app.inject({
        method: "POST",
        url: "/api/users",
        headers: { ...csrf, cookie },
        payload: { username: "console-only", password: "password123", permissions: ["servers.view", "settings.view"] }
      });
      expect(withoutPermission.statusCode, withoutPermission.body).toBe(200);
      const viewerLogin = await app.inject({ method: "POST", url: "/api/auth/login", headers: csrf, payload: { username: "console-only", password: "password123" } });
      const viewerCookie = sessionCookieFrom(viewerLogin);
      // Backend authorization stays the authority: the browser's gating is a saving, not the fence.
      const refusedForViewer = await app.inject({ method: "GET", url: insightsUrl, headers: { ...csrf, cookie: viewerCookie } });
      expect(refusedForViewer.statusCode, refusedForViewer.body).toBe(403);

      const disabled = await app.inject({
        method: "PUT",
        url: "/api/modules/playerInsights",
        headers: { ...csrf, cookie },
        payload: { enabled: false }
      });
      expect(disabled.statusCode, disabled.body).toBe(200);
      expect(services.playerGeoDatabase).toBeUndefined();
      expect(services.playerGeoCollector).toBeUndefined();

      for (const request of [
        { method: "GET" as const, url: insightsUrl },
        { method: "PUT" as const, url: "/api/players/servers/11111111-1111-4111-8111-111111111111/location", payload: { address: "play.example.net" } },
        { method: "POST" as const, url: "/api/players/geo-database/refresh" }
      ]) {
        const response = await app.inject({ ...request, headers: { ...csrf, cookie } });
        expect(response.statusCode, `${request.url} -> ${response.body}`).toBe(403);
        expect(response.json().error.code).toBe("MODULE_DISABLED");
      }

      await app.close();
      app = await buildApp();
      const { services: restarted } = await import("./appServices.js");
      expect(restarted.playerGeoCollector).toBeUndefined();
      const stillRefused = await app.inject({ method: "GET", url: insightsUrl, headers: { ...csrf, cookie } });
      expect(stillRefused.json().error.code).toBe("MODULE_DISABLED");

      const reEnabled = await app.inject({
        method: "PUT",
        url: "/api/modules/playerInsights",
        headers: { ...csrf, cookie },
        payload: { enabled: true }
      });
      expect(reEnabled.statusCode, reEnabled.body).toBe(200);
      expect(restarted.playerGeoCollector).toBeDefined();
      // Disabling was not deleting: the module resumes from what it already knew.
      expect(restarted.playerGeoRepository.stats().entries).toBe(1);
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
      expect(started.statusCode, started.body).toBe(202);
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
