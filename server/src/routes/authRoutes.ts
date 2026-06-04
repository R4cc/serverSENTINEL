import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { ROLE_PRESETS, isFullAccessUser, normalizePermissions } from "../permissions.js";
import type { Permission, PublicUser, RolePreset, Session, StoredUser } from "../types.js";

type UserPermissionData = {
  permissions: Permission[];
  rolePreset: RolePreset;
};

type AuthRoutesContext = {
  authRateLimit: RouteShorthandOptions;
  destructiveRateLimit: RouteShorthandOptions;
  sessions: Map<string, Session>;
  sessionCookieName: string;
  sessionMaxAgeSeconds: number;
  parseCookies(cookieHeader?: string): Map<string, string>;
  sessionCookie(sessionId: string, maxAgeSeconds: number, secure?: boolean): string;
  currentUserFromCookie(cookieHeader?: string): Promise<StoredUser | null>;
  queuedReadUsers(): Promise<StoredUser[]>;
  updateUsers(updater: (users: StoredUser[]) => Promise<void> | void): Promise<void>;
  requireRequestPermission(request: { headers: { cookie?: string } }, permission?: Permission): Promise<StoredUser>;
  validateUsername(username?: string): string;
  validatePassword(password?: string): string;
  normalizeRolePreset(rolePreset?: unknown): RolePreset | undefined;
  buildUserPermissions(input: { rolePreset?: RolePreset; permissions?: unknown[] }, fallback?: StoredUser): UserPermissionData;
  hashPassword(password: string): { salt: string; passwordHash: string };
  verifyPassword(password: string, user: StoredUser): boolean;
  publicUser(user: StoredUser): PublicUser;
  logInfo(fields: Record<string, unknown>, message: string): void;
  logWarn(fields: Record<string, unknown>, message: string): void;
};

export function registerAuthRoutes(app: FastifyInstance, context: AuthRoutesContext) {
  app.get("/api/auth/session", async (request) => {
    const users = await context.queuedReadUsers();
    const user = await context.currentUserFromCookie(request.headers.cookie);
    return {
      authenticated: Boolean(user),
      setupRequired: users.length === 0,
      user: user ? context.publicUser(user) : null
    };
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/register-first", context.authRateLimit, async (request, reply) => {
    const username = context.validateUsername(request.body.username);
    const password = context.validatePassword(request.body.password);
    const now = new Date().toISOString();
    const passwordData = context.hashPassword(password);
    const user: StoredUser = {
      id: randomUUID(),
      username,
      rolePreset: "admin",
      permissions: normalizePermissions(ROLE_PRESETS.admin),
      createdAt: now,
      updatedAt: now,
      ...passwordData
    };
    await context.updateUsers((users) => {
      if (users.length > 0) {
        const error = new Error("Initial registration is already complete") as Error & { statusCode?: number };
        error.statusCode = 403;
        throw error;
      }
      users.push(user);
    });
    const sessionId = randomBytes(32).toString("base64url");
    context.sessions.set(sessionId, { id: sessionId, userId: user.id, createdAt: now });
    const isSecure = request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
    reply.header("Set-Cookie", context.sessionCookie(sessionId, context.sessionMaxAgeSeconds, isSecure));
    context.logInfo({ userId: user.id, username: user.username, rolePreset: user.rolePreset, action: "register_first" }, "Initial admin user created");
    return { authenticated: true, setupRequired: false, user: context.publicUser(user) };
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", context.authRateLimit, async (request, reply) => {
    const username = request.body.username?.trim() ?? "";
    const password = request.body.password ?? "";
    if (username === "demo" && password === "demo") {
      context.logInfo({ username: "demo", action: "login_demo" }, "Demo login requested");
      return { authenticated: false, setupRequired: (await context.queuedReadUsers()).length === 0, demo: true, user: null };
    }
    const users = await context.queuedReadUsers();
    const user = users.find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
    if (!user || !context.verifyPassword(password, user)) {
      context.logWarn({ username, action: "login", status: "failed" }, "Login failed");
      const error = new Error("Invalid username or password") as Error & { statusCode?: number };
      error.statusCode = 401;
      throw error;
    }
    const sessionId = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    context.sessions.set(sessionId, { id: sessionId, userId: user.id, createdAt: now });
    const isSecure = request.protocol === "https" || request.headers["x-forwarded-proto"] === "https";
    reply.header("Set-Cookie", context.sessionCookie(sessionId, context.sessionMaxAgeSeconds, isSecure));
    context.logInfo({ userId: user.id, username: user.username, rolePreset: user.rolePreset, action: "login", status: "succeeded" }, "Login succeeded");
    return { authenticated: true, setupRequired: false, user: context.publicUser(user) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = context.parseCookies(request.headers.cookie).get(context.sessionCookieName);
    if (sessionId) {
      context.sessions.delete(sessionId);
    }
    reply.header("Set-Cookie", context.sessionCookie("", 0));
    context.logInfo({ action: "logout" }, "User logged out");
    return { ok: true };
  });

  app.get("/api/users", async (request) => {
    await context.requireRequestPermission(request, "users.view");
    return { users: (await context.queuedReadUsers()).map(context.publicUser) };
  });

  app.post<{ Body: { username?: string; password?: string; rolePreset?: RolePreset; permissions?: unknown[] } }>("/api/users", context.destructiveRateLimit, async (request) => {
    await context.requireRequestPermission(request, "users.manage");
    const username = context.validateUsername(request.body.username);
    const password = context.validatePassword(request.body.password);
    const rolePreset = context.normalizeRolePreset(request.body.rolePreset);
    const permissionData = context.buildUserPermissions({
      rolePreset,
      permissions: request.body.permissions
    });
    let createdUser: StoredUser | null = null;
    await context.updateUsers((users) => {
      if (users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
        const error = new Error("A user with that username already exists") as Error & { statusCode?: number };
        error.statusCode = 400;
        throw error;
      }
      const now = new Date().toISOString();
      createdUser = {
        id: randomUUID(),
        username,
        rolePreset: permissionData.rolePreset,
        permissions: permissionData.permissions,
        createdAt: now,
        updatedAt: now,
        ...context.hashPassword(password)
      };
      users.push(createdUser);
    });
    context.logInfo({ userId: createdUser!.id, username: createdUser!.username, rolePreset: createdUser!.rolePreset, action: "create_user" }, "User created");
    return context.publicUser(createdUser!);
  });

  app.put<{ Params: { id: string }; Body: { username?: string; password?: string; rolePreset?: RolePreset; permissions?: unknown[] } }>("/api/users/:id", context.destructiveRateLimit, async (request) => {
    await context.requireRequestPermission(request, "users.manage");
    let updatedUser: StoredUser | null = null;
    await context.updateUsers((users) => {
      const index = users.findIndex((user) => user.id === request.params.id);
      if (index === -1) {
        const error = new Error("User not found") as Error & { statusCode?: number };
        error.statusCode = 404;
        throw error;
      }
      const current = users[index];
      const username = request.body.username === undefined ? current.username : context.validateUsername(request.body.username);
      const rolePreset = context.normalizeRolePreset(request.body.rolePreset);
      const permissionData = context.buildUserPermissions({
        rolePreset,
        permissions: request.body.permissions
      }, current);
      const password = request.body.password?.trim() ? context.validatePassword(request.body.password) : undefined;
      if (users.some((user) => user.id !== current.id && user.username.toLowerCase() === username.toLowerCase())) {
        const error = new Error("A user with that username already exists") as Error & { statusCode?: number };
        error.statusCode = 400;
        throw error;
      }
      users[index] = {
        ...current,
        username,
        rolePreset: permissionData.rolePreset,
        permissions: permissionData.permissions,
        updatedAt: new Date().toISOString(),
        ...(password ? context.hashPassword(password) : {})
      };
      updatedUser = users[index];
    });
    context.logInfo({ userId: updatedUser!.id, username: updatedUser!.username, rolePreset: updatedUser!.rolePreset, action: "update_user" }, "User updated");
    return context.publicUser(updatedUser!);
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", context.destructiveRateLimit, async (request) => {
    await context.requireRequestPermission(request, "users.manage");
    let deletedUser: StoredUser | null = null;
    await context.updateUsers((users) => {
      const index = users.findIndex((candidate) => candidate.id === request.params.id);
      if (index === -1) {
        const error = new Error("User not found") as Error & { statusCode?: number };
        error.statusCode = 404;
        throw error;
      }
      const user = users[index];
      if (isFullAccessUser(user) && users.filter(isFullAccessUser).length <= 1) {
        const error = new Error("At least one admin user is required") as Error & { statusCode?: number };
        error.statusCode = 400;
        throw error;
      }
      users.splice(index, 1);
      deletedUser = user;
    });

    for (const [sessionId, session] of context.sessions) {
      if (session.userId === request.params.id) {
        context.sessions.delete(sessionId);
      }
    }
    context.logInfo({ userId: deletedUser!.id, username: deletedUser!.username, action: "delete_user" }, "User deleted");
    return { ok: true };
  });
}
