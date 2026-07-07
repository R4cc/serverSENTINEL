import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAuthRoutes } from "./authRoutes.js";
import type { Permission, PublicUser, RolePreset, Session, StoredUser } from "../types.js";

function authContext(demoEnabled: boolean) {
  const users: StoredUser[] = [];
  const calls = {
    cookies: [] as Array<{ sessionId: string; maxAgeSeconds: number; secure?: boolean }>,
    deletedExpired: [] as string[]
  };
  return {
    calls,
    authRateLimit: {},
    destructiveRateLimit: {},
    sessions: {
      create(_session: Session) {},
      delete(_id: string) {},
      deleteExpired(cutoffCreatedAt: string) {
        calls.deletedExpired.push(cutoffCreatedAt);
        return 0;
      }
    },
    users: {
      list: () => users,
      createFirst(user: StoredUser) { users.push(user); },
      create(user: StoredUser) { users.push(user); },
      updateById(id: string, updater: (user: StoredUser) => StoredUser) {
        const index = users.findIndex((user) => user.id === id);
        if (index === -1) throw new Error("User not found");
        users[index] = updater(users[index]);
        return users[index];
      },
      delete(id: string) {
        const index = users.findIndex((user) => user.id === id);
        if (index === -1) throw new Error("User not found");
        return users.splice(index, 1)[0];
      }
    },
    sessionCookieName: "ss",
    sessionMaxAgeSeconds: 3600,
    parseCookies: () => new Map<string, string>(),
    sessionCookie: (sessionId: string, maxAgeSeconds: number, secure?: boolean) => {
      calls.cookies.push({ sessionId, maxAgeSeconds, secure });
      return `ss=${sessionId}; Path=/; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
    },
    currentUserFromCookie: async () => null,
    requireRequestPermission: async () => {
      throw new Error("Authentication required");
    },
    validateUsername: (username?: string) => username?.trim() || "admin",
    validatePassword: (password?: string) => password || "password",
    normalizeRolePreset: (rolePreset?: unknown) => rolePreset as RolePreset | undefined,
    buildUserPermissions: () => ({ rolePreset: "admin" as RolePreset, permissions: [] as Permission[] }),
    hashPassword: () => ({ salt: "salt", passwordHash: "hash" }),
    verifyPassword: () => false,
    publicUser: (user: StoredUser): PublicUser => ({
      id: user.id,
      username: user.username,
      rolePreset: user.rolePreset,
      permissions: user.permissions,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    }),
    demoEnabled,
    logInfo() {},
    logWarn() {}
  };
}

describe("auth demo login", () => {
  it("rejects demo credentials when demo mode is disabled", async () => {
    const app = Fastify();
    registerAuthRoutes(app, authContext(false));

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "demo", password: "demo" }
    });

    expect(response.statusCode).toBe(401);
  });

  it("returns a demo session when demo mode is explicitly enabled", async () => {
    const app = Fastify();
    registerAuthRoutes(app, authContext(true));

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "demo", password: "demo" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      authenticated: false,
      setupRequired: true,
      demo: true,
      user: null
    });
  });

  it("prunes expired sessions when checking the current auth session", async () => {
    const app = Fastify();
    const context = authContext(false);
    registerAuthRoutes(app, context);

    const response = await app.inject({
      method: "GET",
      url: "/api/auth/session"
    });

    expect(response.statusCode).toBe(200);
    expect(context.calls.deletedExpired).toHaveLength(1);
  });

  it("clears logout cookies with Secure when the public proxy protocol is https", async () => {
    const app = Fastify();
    const context = authContext(false);
    registerAuthRoutes(app, context);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/logout",
      headers: {
        "x-forwarded-proto": "https,http"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(context.calls.cookies.at(-1)).toMatchObject({ sessionId: "", maxAgeSeconds: 0, secure: true });
    expect(response.headers["set-cookie"]).toContain("Secure");
  });
});
