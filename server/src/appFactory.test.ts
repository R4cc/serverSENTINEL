import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  process.env = { ...originalEnv };
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
});
