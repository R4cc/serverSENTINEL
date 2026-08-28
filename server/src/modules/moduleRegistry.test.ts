import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MODULE_IDS } from "@serversentinel/contracts";
import { openStorageDatabase, type StorageDatabase } from "../storage/database.js";
import type { Permission } from "../types.js";
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
    expect(registry.states().map((module) => module.id).sort()).toEqual([...MODULE_IDS].sort());
    expect(registry.states().every((module) => module.enabled)).toBe(true);
    // No user, so nothing is reachable: accessibility is a property of a viewer, not the panel.
    expect(registry.states().every((module) => !module.accessible)).toBe(true);
  });

  it("remembers a disabled module across restarts", async () => {
    const database = await storage();
    await new ModuleRegistry(database).setEnabled("schedules", false);

    expect(new ModuleRegistry(database).isEnabled("schedules")).toBe(false);
  });

  it("folds the viewer's permissions into accessibility without changing the installation state", async () => {
    const registry = new ModuleRegistry(await storage());
    const schedules = (permissions: Permission[]) => registry.states({ permissions }).find((module) => module.id === "schedules");

    expect(schedules(["schedules.view"])).toEqual({ id: "schedules", enabled: true, accessible: true });
    expect(schedules(["servers.view"])).toEqual({ id: "schedules", enabled: true, accessible: false });

    // One module's switch says nothing about another's, for the installation or for the viewer.
    expect(registry.states({ permissions: ["schedules.view", "mods.view"] })
      .find((module) => module.id === "managedContent")).toEqual({ id: "managedContent", enabled: true, accessible: true });

    await registry.setEnabled("schedules", false);
    expect(schedules(["schedules.view"])).toEqual({ id: "schedules", enabled: false, accessible: false });
    expect(registry.isEnabled("managedContent")).toBe(true);
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

  it("opens a module's endpoints only once its runtime has started, and closes them before it stops", async () => {
    // A module whose runtime publishes the services its own routes call — managed content builds
    // its update-plan coordinator this way — would answer a request against a half-built module if
    // the flag moved first. The observed order is the contract, not an implementation detail.
    const registry = new ModuleRegistry(await storage());
    const order: string[] = [];
    registry.registerRuntime("managedContent", {
      start() {
        order.push(`start(enabled=${registry.isEnabled("managedContent")})`);
      },
      stop() {
        order.push(`stop(enabled=${registry.isEnabled("managedContent")})`);
      }
    });

    await registry.startEnabled();
    await registry.setEnabled("managedContent", false);
    await registry.setEnabled("managedContent", true);

    expect(order).toEqual([
      "start(enabled=true)",
      // Disabling closes the endpoints first, so nothing can arrive while the runtime is unwinding.
      "stop(enabled=false)",
      // Enabling starts the runtime first, so nothing can arrive before the services it publishes exist.
      "start(enabled=false)"
    ]);
    expect(registry.isEnabled("managedContent")).toBe(true);
  });

  it("leaves a module off when its runtime cannot start, and says so", async () => {
    const database = await storage();
    const registry = new ModuleRegistry(database);
    registry.registerRuntime("schedules", { start() { throw new Error("scheduler unavailable"); }, stop: vi.fn() });
    await registry.setEnabled("schedules", false);

    await expect(registry.setEnabled("schedules", true)).rejects.toThrow("scheduler unavailable");

    // Nothing was recorded, so a restart does not come back up in a broken state either.
    expect(registry.isEnabled("schedules")).toBe(false);
    expect(new ModuleRegistry(database).isEnabled("schedules")).toBe(false);
  });

  it("keeps a module that failed to start at boot from answering for itself", async () => {
    const registry = new ModuleRegistry(await storage());
    registry.registerRuntime("schedules", { start() { throw new Error("scheduler unavailable"); }, stop: vi.fn() });
    const app = await moduleApp(registry);
    try {
      await registry.startEnabled();

      // The operator's setting still says enabled — that is what Settings should show — but the
      // module cannot answer, so its endpoints refuse instead of running against half a module.
      expect(registry.isEnabled("schedules")).toBe(true);
      expect(registry.isServing("schedules")).toBe(false);
      // Settings still shows the operator's setting, but nobody is offered a module the panel
      // cannot serve — the browser hides it instead of loading a workspace that only errors.
      expect(registry.states({ permissions: ["schedules.view"] }).find((module) => module.id === "schedules"))
        .toEqual({ id: "schedules", enabled: true, accessible: false });
      const refused = await app.inject({ method: "GET", url: "/api/servers/abc/schedules" });
      expect(refused.statusCode).toBe(503);
      expect(refused.json().message).toContain("not running");
      expect((await app.inject({ method: "GET", url: "/api/app" })).statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("starts a runtime registered after boot instead of leaving it dormant", async () => {
    const registry = new ModuleRegistry(await storage());
    await registry.startEnabled();

    const start = vi.fn();
    registry.registerRuntime("schedules", { start, stop: vi.fn() });
    // The start is queued behind whatever else the registry is doing, so settle it the same way a
    // caller would: any state change awaits the same queue.
    await registry.setEnabled("schedules", true);

    expect(start).toHaveBeenCalledTimes(1);
    expect(registry.isServing("schedules")).toBe(true);
  });

  it("serializes overlapping changes so two administrators cannot interleave them", async () => {
    const registry = new ModuleRegistry(await storage());
    const order: string[] = [];
    let releaseStop: (() => void) | undefined;
    registry.registerRuntime("schedules", {
      start() {
        order.push("start");
      },
      async stop() {
        order.push("stop:begin");
        await new Promise<void>((resolve) => { releaseStop = resolve; });
        order.push("stop:end");
      }
    });
    await registry.startEnabled();

    const disabling = registry.setEnabled("schedules", false);
    const reEnabling = registry.setEnabled("schedules", true);
    await vi.waitFor(() => expect(releaseStop).toBeDefined());
    releaseStop?.();
    await disabling;
    await reEnabling;

    expect(order).toEqual(["start", "stop:begin", "stop:end", "start"]);
    expect(registry.isServing("schedules")).toBe(true);
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
    // A runtime that threw partway through may already hold half of what it built, so the failed
    // start is unwound immediately rather than left for shutdown to find.
    expect(stop).toHaveBeenCalledTimes(1);
    expect(registry.isServing("schedules")).toBe(false);

    // And it is not unwound twice: shutdown has nothing left to stop.
    await registry.stopAll();
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
