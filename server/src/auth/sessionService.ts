import { services } from "../appServices.js";
import { currentUserForRequest, type AuthenticatedRequest } from "./requestAuthentication.js";
import { inferRolePreset, permissionsForRolePreset, requirePermission as requireUserPermission, rolePresetFromUnknown, ROLE_PRESETS, normalizePermissions } from "../permissions.js";
import { normalizeStoredUser } from "../storage/usersRepository.js";
import { config } from "../config.js";
import { isDemoUser } from "../demoMode.js";
import type { Permission, PublicUser, RolePreset, Session, StoredUser } from "../types.js";

export const sessionCookieName = "serversentinel_session";
export const sessionMaxAgeSeconds = 60 * 60 * 24 * 14;

export function publicUser(user: StoredUser): PublicUser {
  const normalized = normalizeStoredUser(user);
  return {
    id: normalized.id,
    username: normalized.username,
    rolePreset: normalized.rolePreset,
    permissions: normalized.permissions,
    serverAccess: normalized.serverAccess,
    createdAt: normalized.createdAt
  };
}

export function normalizeRolePreset(rolePreset?: unknown): RolePreset | undefined {
  return rolePreset === undefined ? undefined : rolePresetFromUnknown(rolePreset);
}

export function buildUserPermissions(input: { rolePreset?: RolePreset; permissions?: unknown[] }, fallback?: StoredUser) {
  if (input.permissions !== undefined) {
    const permissions = normalizePermissions(input.permissions);
    return {
      permissions,
      rolePreset: inferRolePreset(permissions)
    };
  }

  if (input.rolePreset !== undefined) {
    const permissions = permissionsForRolePreset(input.rolePreset, fallback?.permissions ?? []);
    return {
      permissions,
      rolePreset: inferRolePreset(permissions)
    };
  }

  if (fallback) {
    const normalized = normalizeStoredUser(fallback);
    return {
      permissions: normalized.permissions,
      rolePreset: normalized.rolePreset
    };
  }

  const permissions = normalizePermissions(ROLE_PRESETS.viewer);
  return {
    permissions,
    rolePreset: inferRolePreset(permissions)
  };
}

export function validatePassword(password?: string) {
  if (!password || password.length < 8 || password.length > 256) {
    const error = new Error("Password must be 8-256 characters") as Error & { statusCode?: number };
    error.statusCode = 400;
    throw error;
  }
  return password;
}

export async function readUsers() {
  return services.usersRepository.list();
}

export function parseCookies(cookieHeader?: string) {
  const cookies = new Map<string, string>();
  for (const part of (cookieHeader ?? "").split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (!rawName || rawValue.length === 0) continue;
    try {
      cookies.set(rawName, decodeURIComponent(rawValue.join("=")));
    } catch {
      // Ignore malformed cookie values; callers will treat missing sessions as unauthenticated.
    }
  }
  return cookies;
}

export function sessionCookie(sessionId: string, maxAgeSeconds: number, secure = false) {
  return `${sessionCookieName}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

export function sessionExpired(session: Pick<Session, "createdAt">, now = Date.now()): boolean {
  const createdAt = new Date(session.createdAt).getTime();
  return !Number.isFinite(createdAt) || now - createdAt > sessionMaxAgeSeconds * 1000;
}

export async function currentUserFromCookie(cookieHeader?: string) {
  const sessionId = parseCookies(cookieHeader).get(sessionCookieName);
  if (!sessionId) return null;
  const session = services.sessionsRepository.find(sessionId);
  if (!session) return null;
  if (sessionExpired(session)) {
    services.sessionsRepository.delete(sessionId);
    return null;
  }
  return services.usersRepository.findById(session.userId) ?? null;
}

export async function requireAuthenticated(request: AuthenticatedRequest) {
  const user = await currentUserForRequest(request, currentUserFromCookie);
  if (!user) {
    const error = new Error("Authentication required") as Error & { statusCode?: number };
    error.statusCode = 401;
    throw error;
  }
  return user;
}

export async function requireRequestPermission(request: AuthenticatedRequest, permission?: Permission) {
  const user = await requireAuthenticated(request);
  if (permission) {
    requireUserPermission(permission)(user);
  }
  return user;
}

export async function isDemoModeRequest(request: AuthenticatedRequest) {
  if (!config.enableDemo) return false;
  return isDemoUser(await currentUserForRequest(request, currentUserFromCookie));
}

// Upstream runtime/version catalogs back both the create and the edit-properties
// flows, so they gate on the permission both of those imply rather than on
// servers.create alone. Demo sessions read the catalogs without a server list.
export async function requireVersionCatalogAccess(request: AuthenticatedRequest) {
  if (await isDemoModeRequest(request)) return;
  await requireRequestPermission(request, "servers.view");
}
