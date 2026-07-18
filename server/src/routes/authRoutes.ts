import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { randomBytes, randomUUID } from "node:crypto";
import { ROLE_PRESETS, normalizePermissions } from "../permissions.js";
import type { Permission, PublicUser, RolePreset, Session, StoredUser } from "../types.js";
import { requestUsesPublicHttps } from "../http/requestOrigin.js";
import type { AuthenticatedRequest } from "../auth/requestAuthentication.js";

type UserPermissionData = {
  permissions: Permission[];
  rolePreset: RolePreset;
};

type AuthRoutesContext = {
  authRateLimit: RouteShorthandOptions;
  destructiveRateLimit: RouteShorthandOptions;
  sessions: {
    create(session: Session): void;
    delete(id: string): void;
    deleteForUser(userId: string): number;
    deleteExpired(cutoffCreatedAt: string): number;
  };
  users: {
    list(): StoredUser[];
    createFirst(user: StoredUser, session: Session): void;
    create(user: StoredUser): void;
    updateById(id: string, updater: (user: StoredUser) => StoredUser): StoredUser;
    delete(id: string): StoredUser;
  };
  sessionCookieName: string;
  sessionMaxAgeSeconds: number;
  parseCookies(cookieHeader?: string): Map<string, string>;
  sessionCookie(sessionId: string, maxAgeSeconds: number, secure?: boolean): string;
  trustProxy: boolean;
  verifySetupToken(token: unknown): boolean;
  currentUserFromCookie(cookieHeader?: string): Promise<StoredUser | null>;
  requireRequestPermission(request: AuthenticatedRequest, permission?: Permission): Promise<StoredUser>;
  validateUsername(username?: string): string;
  validatePassword(password?: string): string;
  normalizeRolePreset(rolePreset?: unknown): RolePreset | undefined;
  buildUserPermissions(input: { rolePreset?: RolePreset; permissions?: unknown[] }, fallback?: StoredUser): UserPermissionData;
  hashPassword(password: string): { salt: string; passwordHash: string };
  verifyPassword(password: string, user: StoredUser): boolean;
  publicUser(user: StoredUser): PublicUser;
  demoEnabled: boolean;
  isDemoUser(user: Pick<StoredUser, "username"> | null | undefined): boolean;
  logInfo(fields: Record<string, unknown>, message: string): void;
  logWarn(fields: Record<string, unknown>, message: string): void;
};

function pruneExpiredSessions(context: AuthRoutesContext, now = Date.now()) {
  context.sessions.deleteExpired(new Date(now - context.sessionMaxAgeSeconds * 1000).toISOString());
}

export function registerAuthRoutes(app: FastifyInstance, context: AuthRoutesContext) {
  app.get("/api/auth/session", async (request) => {
    pruneExpiredSessions(context);
    const users = context.users.list();
    const user = await context.currentUserFromCookie(request.headers.cookie);
    return {
      authenticated: Boolean(user),
      setupRequired: users.length === 0,
      demoEnabled: context.demoEnabled,
      demo: context.demoEnabled && context.isDemoUser(user),
      user: user ? context.publicUser(user) : null
    };
  });

  app.post<{ Body: { username?: string; password?: string; setupToken?: string } }>("/api/auth/register-first", context.authRateLimit, async (request, reply) => {
    const body = request.body ?? {};
    if (!context.verifySetupToken(body.setupToken)) {
      const error = new Error("Invalid initial setup token") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    if (context.users.list().length !== 0) {
      const error = new Error("Initial registration is already complete") as Error & { statusCode?: number };
      error.statusCode = 409;
      throw error;
    }
    const username = context.validateUsername(body.username);
    const password = context.validatePassword(body.password);
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
    const sessionId = randomBytes(32).toString("base64url");
    context.users.createFirst(user, { id: sessionId, userId: user.id, createdAt: now });
    pruneExpiredSessions(context);
    const isSecure = requestUsesPublicHttps(request, context.trustProxy);
    reply.header("Set-Cookie", context.sessionCookie(sessionId, context.sessionMaxAgeSeconds, isSecure));
    context.logInfo({ userId: user.id, username: user.username, rolePreset: user.rolePreset, action: "register_first" }, "Initial admin user created");
    return { authenticated: true, setupRequired: false, demoEnabled: context.demoEnabled, demo: false, user: context.publicUser(user) };
  });

  app.post<{ Body: { username?: string; password?: string } }>("/api/auth/login", context.authRateLimit, async (request, reply) => {
    const body = request.body ?? {};
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" && body.password.length <= 256 ? body.password : "";
    const users = context.users.list();
    const user = users.find((candidate) => candidate.username.toLowerCase() === username.toLowerCase());
    if (!user || !context.verifyPassword(password, user)) {
      context.logWarn({ username, action: "login", status: "failed" }, "Login failed");
      const error = new Error("Invalid username or password") as Error & { statusCode?: number };
      error.statusCode = 401;
      throw error;
    }
    const sessionId = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    context.sessions.create({ id: sessionId, userId: user.id, createdAt: now });
    pruneExpiredSessions(context);
    const isSecure = requestUsesPublicHttps(request, context.trustProxy);
    reply.header("Set-Cookie", context.sessionCookie(sessionId, context.sessionMaxAgeSeconds, isSecure));
    context.logInfo({ userId: user.id, username: user.username, rolePreset: user.rolePreset, action: "login", status: "succeeded" }, "Login succeeded");
    const demo = context.demoEnabled && context.isDemoUser(user);
    return { authenticated: true, setupRequired: false, demoEnabled: context.demoEnabled, demo, user: context.publicUser(user) };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const sessionId = context.parseCookies(request.headers.cookie).get(context.sessionCookieName);
    if (sessionId) {
      context.sessions.delete(sessionId);
    }
    reply.header("Set-Cookie", context.sessionCookie("", 0, requestUsesPublicHttps(request, context.trustProxy)));
    context.logInfo({ action: "logout" }, "User logged out");
    return { ok: true };
  });

  app.get("/api/users", async (request) => {
    await context.requireRequestPermission(request, "users.view");
    return { users: context.users.list().map(context.publicUser) };
  });

  app.post<{ Body: { username?: string; password?: string; rolePreset?: RolePreset; permissions?: unknown[] } }>("/api/users", context.destructiveRateLimit, async (request) => {
    await context.requireRequestPermission(request, "users.manage");
    const body = request.body ?? {};
    const username = context.validateUsername(body.username);
    const password = context.validatePassword(body.password);
    const rolePreset = context.normalizeRolePreset(body.rolePreset);
    const permissionData = context.buildUserPermissions({
      rolePreset,
      permissions: body.permissions
    });
    const now = new Date().toISOString();
    const createdUser: StoredUser = {
      id: randomUUID(), username, rolePreset: permissionData.rolePreset,
      permissions: permissionData.permissions, createdAt: now, updatedAt: now,
      ...context.hashPassword(password)
    };
    context.users.create(createdUser);
    context.logInfo({ userId: createdUser.id, username: createdUser.username, rolePreset: createdUser.rolePreset, action: "create_user" }, "User created");
    return context.publicUser(createdUser);
  });

  app.put<{ Params: { id: string }; Body: { username?: string; password?: string; rolePreset?: RolePreset; permissions?: unknown[] } }>("/api/users/:id", context.destructiveRateLimit, async (request) => {
    await context.requireRequestPermission(request, "users.manage");
    const target = context.users.list().find((user) => user.id === request.params.id);
    if (context.demoEnabled && context.isDemoUser(target)) {
      const error = new Error("The demo user is managed by demo-mode startup and cannot be changed") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const body = request.body ?? {};
    const updatedUser = context.users.updateById(request.params.id, (current) => {
      const username = body.username === undefined ? current.username : context.validateUsername(body.username);
      const rolePreset = context.normalizeRolePreset(body.rolePreset);
      const permissionData = context.buildUserPermissions({
        rolePreset,
        permissions: body.permissions
      }, current);
      const password = typeof body.password === "string" && body.password.trim() ? context.validatePassword(body.password) : undefined;
      return {
        ...current,
        username,
        rolePreset: permissionData.rolePreset,
        permissions: permissionData.permissions,
        updatedAt: new Date().toISOString(),
        ...(password ? context.hashPassword(password) : {})
      };
    });
    if (typeof body.password === "string" && body.password.trim()) {
      context.sessions.deleteForUser(updatedUser.id);
    }
    context.logInfo({ userId: updatedUser.id, username: updatedUser.username, rolePreset: updatedUser.rolePreset, action: "update_user" }, "User updated");
    return context.publicUser(updatedUser);
  });

  app.delete<{ Params: { id: string } }>("/api/users/:id", context.destructiveRateLimit, async (request) => {
    await context.requireRequestPermission(request, "users.manage");
    const target = context.users.list().find((user) => user.id === request.params.id);
    if (context.demoEnabled && context.isDemoUser(target)) {
      const error = new Error("The demo user is managed by demo-mode startup and cannot be deleted") as Error & { statusCode?: number };
      error.statusCode = 403;
      throw error;
    }
    const deletedUser = context.users.delete(request.params.id);
    context.logInfo({ userId: deletedUser.id, username: deletedUser.username, action: "delete_user" }, "User deleted");
    return { ok: true };
  });
}
