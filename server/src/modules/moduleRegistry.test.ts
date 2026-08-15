import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorageDatabase, type StorageDatabase } from "../storage/database.js";
import { ModuleRegistry } from "./moduleRegistry.js";

const roots: string[] = [];
const databases: StorageDatabase[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function storage() {
  const root = await mkdtemp(join(tmpdir(), "serversentinel-modules-"));
  roots.push(root);
  const database = openStorageDatabase(join(root, "state.sqlite"));
  databases.push(database);
  return database;
}

/** An app whose module route is registered exactly as `app.ts` registers a real one. */
async function moduleApp(registry: ModuleRegistry) {
  const app = Fastify();
  await registry.registerRoutes(app, "schedules", (scope) => {
    scope.get("/api/servers/:id/schedules", async () => ({ schedules: [] }));
  });
  app.get("/api/app", async () => ({ ok: true }));
  await app.ready();
  return app;
}

describe("optional module registry", () => {
  it("treats a module with no stored opinion as enabled, so an upgrade changes nothing", async () => {
    const registry = new ModuleRegistry(await storage());
    expect(registry.isEnabled("schedules")).toBe(true);
    expect(registry.states()).toEqual([{ id: "schedules", enabled: true, accessible: false }]);
  });

  it("remembers a disabled module across restarts", async () => {
    const database = await storage();
    await new ModuleRegistry(database).setEnabled("schedules", false);

    expect(new ModuleRegistry(database).isEnabled("schedules")).toBe(false);
  });

  it("folds the viewer's permissions into accessibility without changing the installation state", async () => {
    const registry = new ModuleRegistry(await storage());

    expect(registry.states({ permissions: ["schedules.view"] })).toEqual([{ id: "schedules", enabled: true, accessible: true }]);
    expect(registry.states({ permissions: ["servers.view"] })).toEqual([{ id: "schedules", enabled: true, accessible: false }]);

    await registry.setEnabled("schedules", false);
    expect(registry.states({ permissions: ["schedules.view"] })).toEqual([{ id: "schedules", enabled: false, accessible: false }]);
  });

  it("refuses a disabled module's endpoints while the rest of the panel keeps answering", async () => {
    const registry = new ModuleRegistry(await storage());
    const app = await moduleApp(registry);
    try {
      expect((await app.inject({ method: "GET", url: "/api/servers/abc/schedules" })).statusCode).toBe(200);

      await registry.setEnabled("schedules", false);

      const refused = await app.inject({ method: "GET", url: "/api/servers/abc/schedules" });
      expect(refused.statusCode).toBe(403);
      expect(refused.json().message).toContain("Schedules module is disabled");
      expect((await app.inject({ method: "GET", url: "/api/app" })).statusCode).toBe(200);

      // Re-enabling has to take effect on the running panel: the guard is consulted per request
      // rather than at registration, so no restart is involved.
      await registry.setEnabled("schedules", true);
      expect((await app.inject({ method: "GET", url: "/api/servers/abc/schedules" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("starts background work only for enabled modules and stops it when one is switched off", async () => {
    const database = await storage();
    const registry = new ModuleRegistry(database);
    const start = vi.fn();
    const stop = vi.fn();
    registry.registerRuntime("schedules", { start, stop });

    await registry.startEnabled();
    expect(start).toHaveBeenCalledTimes(1);

    await registry.setEnabled("schedules", false);
    expect(stop).toHaveBeenCalledTimes(1);

    // Already off: neither call should run again.
    await registry.setEnabled("schedules", false);
    expect(stop).toHaveBeenCalledTimes(1);

    await registry.setEnabled("schedules", true);
    expect(start).toHaveBeenCalledTimes(2);

    await registry.stopAll();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it("leaves a disabled module's background work unstarted at boot", async () => {
    const database = await storage();
    await new ModuleRegistry(database).setEnabled("schedules", false);

    const registry = new ModuleRegistry(database);
    const start = vi.fn();
    registry.registerRuntime("schedules", { start, stop: vi.fn() });
    await registry.startEnabled();

    expect(start).not.toHaveBeenCalled();
  });

  it("reports a runtime that cannot start instead of leaving it recorded as running", async () => {
    const registry = new ModuleRegistry(await storage(), {
      onRuntimeError: (error, id, phase) => { failures.push({ message: (error as Error).message, id, phase }); }
    });
    const failures: Array<{ message: string; id: string; phase: string }> = [];
    const start = vi.fn(() => { throw new Error("scheduler unavailable"); });
    const stop = vi.fn();
    registry.registerRuntime("schedules", { start, stop });

    await registry.startEnabled();
    expect(failures).toEqual([{ message: "scheduler unavailable", id: "schedules", phase: "start" }]);

    // The failed start left nothing running, so shutting down must not call `stop` on it.
    await registry.stopAll();
    expect(stop).not.toHaveBeenCalled();
  });
});
