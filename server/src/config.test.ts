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

    await expect(loadConfig({
      SS_MODE: "node",
      SS_PANEL_URL: "ftp://panel.example.com",
      SERVERSENTINEL_DOCKER_DATA_DIR: "/srv/serversentinel"
    })).rejects.toThrow("credential-free http or https");

    await expect(loadConfig({
      SS_MODE: "node",
      SS_PANEL_URL: "https://user:password@panel.example.com",
      SERVERSENTINEL_DOCKER_DATA_DIR: "/srv/serversentinel"
    })).rejects.toThrow("credential-free http or https");
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
    await expect(loadConfig({ SERVERSENTINEL_ENABLE_DEMO: "yes" })).rejects.toThrow("must be true or false");
  });

  it("requires explicit proxy trust and validates fixed setup tokens", async () => {
    await expect(loadConfig({ SERVERSENTINEL_TRUST_PROXY: undefined })).resolves.toMatchObject({ config: { trustProxy: false } });
    await expect(loadConfig({ SERVERSENTINEL_TRUST_PROXY: "true" })).resolves.toMatchObject({ config: { trustProxy: true } });
    await expect(loadConfig({ SERVERSENTINEL_SETUP_TOKEN: "too-short" })).rejects.toThrow("16-256 characters");
    await expect(loadConfig({ SERVERSENTINEL_SETUP_TOKEN: "0123456789abcdef" })).resolves.toMatchObject({
      config: { setupToken: "0123456789abcdef" }
    });
  });

  it("uses TZ for runtime time display and defaults to UTC", async () => {
    await expect(loadConfig({ TZ: undefined })).resolves.toMatchObject({
      config: { timeZone: "UTC" },
      runtimeTimeZone: "UTC"
    });
    expect(process.env.TZ).toBe("UTC");

    await expect(loadConfig({ TZ: "Europe/Vienna" })).resolves.toMatchObject({
      config: { timeZone: "Europe/Vienna" },
      runtimeTimeZone: "Europe/Vienna"
    });
    expect(process.env.TZ).toBe("Europe/Vienna");

    await expect(loadConfig({ TZ: "not/a-zone" })).resolves.toMatchObject({
      config: { timeZone: "UTC" },
      runtimeTimeZone: "UTC"
    });
    expect(process.env.TZ).toBe("UTC");
  });

  it("fails fast when PORT is not a usable HTTP port", async () => {
    await expect(loadConfig({ PORT: "not-a-port" })).rejects.toThrow("PORT must be a whole number");
    await expect(loadConfig({ PORT: "0" })).rejects.toThrow("PORT must be a whole number");
    await expect(loadConfig({ PORT: "65536" })).rejects.toThrow("PORT must be a whole number");
    await expect(loadConfig({ PORT: "8081" })).resolves.toMatchObject({
      config: { port: 8081 }
    });
  });
});
