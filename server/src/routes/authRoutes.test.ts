import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerAuthRoutes } from "./authRoutes.js";
import type { Permission, PublicUser, RolePreset, Session, StoredUser } from "../types.js";

function authContext(demoEnabled: boolean) {
  const users: StoredUser[] = [];
  return {
    authRateLimit: {},
    destructiveRateLimit: {},
    sessions: {
      create(_session: Session) {},
      delete(_id: string) {}
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
    sessionCookie: () => "ss=; Path=/",
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
});
