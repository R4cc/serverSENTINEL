import { inferRolePreset, isFullAccessUser, normalizePermissions, rolePresetFromUnknown } from "../permissions.js";
import type { ServerAccess, StoredUser } from "../types.js";
import { asArray, asObject, optionalString, requiredString } from "./jsonFile.js";
import type { StorageDatabase } from "./database.js";

type UserRow = {
  id: string;
  username: string;
  password_hash: string;
  salt: string;
  role_preset: string;
  permissions_json: string;
  server_access_json: string | null;
  created_at: string;
  updated_at: string;
};

function badUserRequest(message: string): never {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = 400;
  throw error;
}

export function validateUsername(username?: string) {
  const value = username?.trim();
  if (!value || value.length < 3 || value.length > 32 || !/^[a-zA-Z0-9_.-]+$/.test(value)) {
    badUserRequest("Username must be 3-32 characters and use letters, numbers, dots, dashes, or underscores");
  }
  return value;
}

function normalizeServerAccess(value: unknown): ServerAccess | undefined {
  if (value === undefined || value === null) return undefined;
  const access = asObject(value, "user.serverAccess");
  if (access.mode === "all") return { mode: "all", serverIds: [] };
  if (access.mode === "selected") {
    return {
      mode: "selected",
      serverIds: asArray(access.serverIds, "user.serverAccess.serverIds")
        .map((id) => requiredString(id, "user.serverAccess.serverIds[]"))
    };
  }
  throw new Error("user.serverAccess.mode must be all or selected");
}

export function normalizeStoredUser(value: unknown): StoredUser {
  const user = asObject(value, "stored user");
  const permissions = normalizePermissions(asArray(user.permissions, "user.permissions"));
  const inferredPreset = inferRolePreset(permissions);
  const rolePreset = user.rolePreset === undefined ? inferredPreset : rolePresetFromUnknown(user.rolePreset);
  const effectivePreset = rolePreset === "custom" || inferRolePreset(permissions) === rolePreset ? rolePreset : "custom";
  return {
    id: requiredString(user.id, "user.id"),
    username: validateUsername(optionalString(user.username, "user.username")),
    passwordHash: requiredString(user.passwordHash, "user.passwordHash"),
    salt: requiredString(user.salt, "user.salt"),
    rolePreset: effectivePreset,
    permissions,
    serverAccess: normalizeServerAccess(user.serverAccess),
    createdAt: requiredString(user.createdAt, "user.createdAt"),
    updatedAt: requiredString(user.updatedAt, "user.updatedAt")
  };
}

function userFromRow(row: UserRow): StoredUser {
  return normalizeStoredUser({
    id: row.id,
    username: row.username,
    passwordHash: row.password_hash,
    salt: row.salt,
    rolePreset: row.role_preset,
    permissions: JSON.parse(row.permissions_json) as unknown,
    serverAccess: row.server_access_json ? JSON.parse(row.server_access_json) as unknown : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}

export class UsersRepository {
  constructor(private readonly storage: StorageDatabase) {}

  list(): StoredUser[] {
    return this.storage.connection.prepare<[], UserRow>(`
      SELECT id, username, password_hash, salt, role_preset, permissions_json,
             server_access_json, created_at, updated_at
      FROM users ORDER BY created_at, id
    `).all().map(userFromRow);
  }

  update(updater: (users: StoredUser[]) => void) {
    this.storage.transaction((database) => {
      const users = this.list();
      updater(users);
      const normalized = users.map(normalizeStoredUser);
      if (normalized.length > 0 && !normalized.some(isFullAccessUser)) {
        badUserRequest("At least one full-access admin user is required");
      }

      const existingIds = new Set(database.prepare<[], { id: string }>("SELECT id FROM users").all().map((row) => row.id));
      const upsert = database.prepare(`
        INSERT INTO users (
          id, username, password_hash, salt, role_preset, permissions_json,
          server_access_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          username = excluded.username,
          password_hash = excluded.password_hash,
          salt = excluded.salt,
          role_preset = excluded.role_preset,
          permissions_json = excluded.permissions_json,
          server_access_json = excluded.server_access_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `);
      for (const user of normalized) {
        upsert.run(
          user.id, user.username, user.passwordHash, user.salt, user.rolePreset,
          JSON.stringify(user.permissions), user.serverAccess ? JSON.stringify(user.serverAccess) : null,
          user.createdAt, user.updatedAt
        );
        existingIds.delete(user.id);
      }
      const remove = database.prepare("DELETE FROM users WHERE id = ?");
      for (const id of existingIds) remove.run(id);
    });
  }
}
