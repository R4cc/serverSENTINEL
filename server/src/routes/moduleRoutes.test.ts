import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ModuleAccessState } from "@serversentinel/contracts";
import type { Permission, StoredUser } from "../types.js";
import { registerModuleRoutes } from "./moduleRoutes.js";

function testApp(options: { permissions?: Permission[] } = {}) {
  const app = Fastify();
  const permissions = options.permissions ?? ["settings.view", "integrations.manage"];
  const user = { id: "user-1", permissions } as StoredUser;
  let enabled = true;
  let destructiveRateLimitCalls = 0;
  const setEnabled = vi.fn(async (_id: string, next: boolean) => {
    enabled = next;
    return states();
  });
  const states = (): ModuleAccessState[] => [{ id: "schedules", enabled, accessible: enabled && permissions.includes("schedules.view") }];
  const logInfo = vi.fn();

  registerModuleRoutes(app, {
    destructiveRateLimit: {
      preHandler: async () => {
        destructiveRateLimitCalls += 1;
      }
    },
    requireRequestPermission: async (_request, permission) => {
      if (!permissions.includes(permission)) {
        const error = new Error(`Missing permission: ${permission}`) as Error & { statusCode?: number };
        error.statusCode = 403;
        throw error;
      }
      return user;
    },
    states: () => states(),
    setEnabled,
    logInfo
  });

  return { app, setEnabled, logInfo, isEnabled: () => enabled, destructiveRateLimitCalls: () => destructiveRateLimitCalls };
}

describe("module routes", () => {
  it("lists the catalog for anyone who can open settings", async () => {
    const { app } = testApp({ permissions: ["settings.view"] });
    const response = await app.inject({ method: "GET", url: "/api/modules" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ modules: [{ id: "schedules", enabled: true, accessible: false }] });
    await app.close();
  });

  it("refuses to read the catalog without settings access", async () => {
    const { app } = testApp({ permissions: [] });
    expect((await app.inject({ method: "GET", url: "/api/modules" })).statusCode).toBe(403);
    await app.close();
  });

  it("holds the installation switch to the integrations grant", async () => {
    const { app, setEnabled } = testApp({ permissions: ["settings.view"] });
    const response = await app.inject({ method: "PUT", url: "/api/modules/schedules", payload: { enabled: false } });

    expect(response.statusCode).toBe(403);
    expect(setEnabled).not.toHaveBeenCalled();
    await app.close();
  });

  it("switches a module off and answers with the refreshed catalog", async () => {
    const { app, setEnabled, logInfo, isEnabled, destructiveRateLimitCalls } = testApp();
    const response = await app.inject({ method: "PUT", url: "/api/modules/schedules", payload: { enabled: false } });

    expect(response.statusCode).toBe(200);
    expect(setEnabled).toHaveBeenCalledWith("schedules", false);
    expect(isEnabled()).toBe(false);
    expect(response.json().modules).toEqual([{ id: "schedules", enabled: false, accessible: false }]);
    expect(destructiveRateLimitCalls()).toBe(1);
    expect(logInfo).toHaveBeenCalledWith(expect.objectContaining({ action: "configure_module", moduleId: "schedules", enabled: false }), expect.any(String));
    await app.close();
  });

  it("rejects an unknown module and a non-boolean state", async () => {
    const { app, setEnabled } = testApp();

    expect((await app.inject({ method: "PUT", url: "/api/modules/telemetry", payload: { enabled: false } })).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url: "/api/modules/schedules", payload: { enabled: "false" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "PUT", url: "/api/modules/schedules", payload: {} })).statusCode).toBe(400);
    expect(setEnabled).not.toHaveBeenCalled();
    await app.close();
  });
});
