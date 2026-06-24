import { afterEach, describe, expect, it, vi } from "vitest";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
  vi.resetModules();
});

async function loadConfig(env: Record<string, string | undefined>) {
  process.env = { ...originalEnv };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.resetModules();
  return import("./config.js");
}

describe("runtime role configuration", () => {
  it("fails fast in node mode when required panel or Docker host data settings are missing", async () => {
    await expect(loadConfig({
      SS_MODE: "node",
      SS_PANEL_URL: undefined,
      SERVERSENTINEL_DOCKER_DATA_DIR: "/srv/serversentinel"
    })).rejects.toThrow("SS_PANEL_URL is required");

    await expect(loadConfig({
      SS_MODE: "node",
      SS_PANEL_URL: "http://panel:8080",
      SERVERSENTINEL_DOCKER_DATA_DIR: undefined
    })).rejects.toThrow("SERVERSENTINEL_DOCKER_DATA_DIR is required");
  });

  it("keeps panel mode independent from node-only Docker data settings", async () => {
    const { config } = await loadConfig({
      SS_MODE: "panel",
      SS_PANEL_URL: undefined,
      SERVERSENTINEL_DOCKER_DATA_DIR: undefined
    });

    expect(config.runtimeMode).toBe("panel");
    expect(config.panelUrl).toBeUndefined();
  });

  it("keeps demo mode disabled unless explicitly enabled", async () => {
    await expect(loadConfig({ SERVERSENTINEL_ENABLE_DEMO: undefined })).resolves.toMatchObject({
      config: { enableDemo: false }
    });
    await expect(loadConfig({ SERVERSENTINEL_ENABLE_DEMO: "false" })).resolves.toMatchObject({
      config: { enableDemo: false }
    });
    await expect(loadConfig({ SERVERSENTINEL_ENABLE_DEMO: "true" })).resolves.toMatchObject({
      config: { enableDemo: true }
    });
  });
});
