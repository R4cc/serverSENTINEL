import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
});
