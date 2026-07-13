import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAuthRoutes } from "./authRoutes.js";
import type { Permission, PublicUser, RolePreset, Session, StoredUser } from "../types.js";

function authContext(demoEnabled: boolean, permissionGranted = false) {
  const users: StoredUser[] = [];
  if (demoEnabled) {
    users.push({
      id: "demo-user",
      username: "demo",
      passwordHash: "demo-hash",
      salt: "demo-salt",
      rolePreset: "admin",
      permissions: ["servers.view", "users.view", "users.manage"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    });
  }
  const calls = {
    cookies: [] as Array<{ sessionId: string; maxAgeSeconds: number; secure?: boolean }>,
    deletedExpired: [] as string[],
    sessions: [] as Session[],
    deletedForUsers: [] as string[]
  };
  return {
    calls,
    authRateLimit: {},
    destructiveRateLimit: {},
    sessions: {
      create(session: Session) { calls.sessions.push(session); },
      delete(_id: string) {},
      deleteForUser(userId: string) {
        calls.deletedForUsers.push(userId);
        return 1;
      },
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
    trustProxy: true,
    verifySetupToken: (token: unknown) => token === "test-setup-token",
    parseCookies: () => new Map<string, string>(),
    sessionCookie: (sessionId: string, maxAgeSeconds: number, secure?: boolean) => {
      calls.cookies.push({ sessionId, maxAgeSeconds, secure });
      return `ss=${sessionId}; Path=/; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
    },
    currentUserFromCookie: async () => null,
    requireRequestPermission: async () => {
      if (permissionGranted && users[0]) return users[0];
      throw new Error("Authentication required");
    },
    validateUsername: (username?: string) => username?.trim() || "admin",
    validatePassword: (password?: string) => password || "password",
    normalizeRolePreset: (rolePreset?: unknown) => rolePreset as RolePreset | undefined,
    buildUserPermissions: () => ({ rolePreset: "admin" as RolePreset, permissions: [] as Permission[] }),
    hashPassword: () => ({ salt: "salt", passwordHash: "hash" }),
    verifyPassword: (password: string, user: StoredUser) => demoEnabled && user.username === "demo" && password === "demo",
    publicUser: (user: StoredUser): PublicUser => ({
      id: user.id,
      username: user.username,
      rolePreset: user.rolePreset,
      permissions: user.permissions,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt
    }),
    demoEnabled,
    isDemoUser: (user: Pick<StoredUser, "username"> | null | undefined) => user?.username.toLowerCase() === "demo",
    logInfo() {},
    logWarn() {}
  };
}

describe("auth demo login", () => {
  it("requires the one-time setup token before creating the first administrator", async () => {
    const app = Fastify();
    const context = authContext(false);
    registerAuthRoutes(app, context);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/auth/register-first",
      payload: { username: "admin", password: "password123", setupToken: "wrong" }
    });
    expect(rejected.statusCode).toBe(403);

    const created = await app.inject({
      method: "POST",
      url: "/api/auth/register-first",
      payload: { username: "admin", password: "password123", setupToken: "test-setup-token" }
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ authenticated: true, user: { username: "admin" } });

    const repeated = await app.inject({
      method: "POST",
      url: "/api/auth/register-first",
      payload: { username: "other-admin", password: "password123", setupToken: "test-setup-token" }
    });
    expect(repeated.statusCode).toBe(409);
  });

  it("revokes a user's existing sessions when their password changes", async () => {
    const app = Fastify();
    const context = authContext(false, true);
    registerAuthRoutes(app, context);
    const created = await app.inject({
      method: "POST",
      url: "/api/auth/register-first",
      payload: { username: "admin", password: "password123", setupToken: "test-setup-token" }
    });
    const userId = created.json().user.id as string;

    const updated = await app.inject({
      method: "PUT",
      url: `/api/users/${userId}`,
      payload: { password: "new-password-123" }
    });

    expect(updated.statusCode).toBe(200);
    expect(context.calls.deletedForUsers).toEqual([userId]);
  });

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

  it("creates a real authenticated demo session when demo mode is explicitly enabled", async () => {
    const app = Fastify();
    const context = authContext(true);
    registerAuthRoutes(app, context);

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/login",
      payload: { username: "demo", password: "demo" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      authenticated: true,
      setupRequired: false,
      demoEnabled: true,
      demo: true,
      user: { id: "demo-user", username: "demo", rolePreset: "admin" }
    });
    expect(context.calls.sessions).toHaveLength(1);
    expect(response.headers["set-cookie"]).toContain("ss=");
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
