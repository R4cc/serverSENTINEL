import type Database from "better-sqlite3";
import { inferRolePreset, isFullAccessUser, normalizePermissions, rolePresetFromUnknown } from "../permissions.js";
import type { ServerAccess, Session, StoredUser } from "../types.js";
import { asArray, asObject, optionalString, requiredString } from "./valueValidation.js";
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
  const effectivePreset = rolePreset === "custom" || inferredPreset === rolePreset ? rolePreset : "custom";
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

  createFirst(user: StoredUser, session: Session) {
    this.storage.transaction((database) => {
      if (database.prepare("SELECT 1 FROM users LIMIT 1").get()) {
        const error = new Error("Initial registration is already complete") as Error & { statusCode?: number };
        error.statusCode = 403;
        throw error;
      }
      this.save(database, user, false);
      this.assertHasAdmin();
      database.prepare("INSERT INTO sessions (id, user_id, created_at) VALUES (?, ?, ?)")
        .run(session.id, session.userId, session.createdAt);
    });
  }

  create(user: StoredUser) {
    this.storage.transaction((database) => {
      this.save(database, user, false);
      this.assertHasAdmin();
    });
  }

  /**
   * Repairs an application-owned account without first parsing its stored row.
   * This deliberately tolerates stale hashes and malformed role/permission JSON
   * so demo-mode startup can recover an interrupted or manually modified seed.
   */
  repairSystemUser(value: StoredUser): StoredUser {
    const desired = normalizeStoredUser(value);
    return this.storage.transaction((database) => {
      const byUsername = database.prepare<[string], { id: string; created_at: string }>(
        "SELECT id, created_at FROM users WHERE username = ? COLLATE NOCASE"
      ).get(desired.username);
      const byId = byUsername
        ? undefined
        : database.prepare<[string], { id: string; created_at: string }>(
            "SELECT id, created_at FROM users WHERE id = ?"
          ).get(desired.id);
      const existing = byUsername ?? byId;
      const repaired = normalizeStoredUser({
        ...desired,
        id: existing?.id ?? desired.id,
        createdAt: existing?.created_at?.trim() || desired.createdAt
      });

      this.save(database, repaired, Boolean(existing));
      return repaired;
    });
  }

  updateById(id: string, updater: (user: StoredUser) => StoredUser): StoredUser {
    return this.storage.transaction((database) => {
      const current = this.findById(id);
      if (!current) this.notFound();
      const updated = normalizeStoredUser(updater(current));
      if (updated.id !== id) badUserRequest("User id cannot be changed");
      this.save(database, updated, true);
      this.assertHasAdmin();
      return updated;
    });
  }

  delete(id: string): StoredUser {
    return this.storage.transaction((database) => {
      const user = this.findById(id);
      if (!user) this.notFound();
      if (isFullAccessUser(user) && this.list().filter(isFullAccessUser).length <= 1) {
        badUserRequest("At least one admin user is required");
      }
      database.prepare("DELETE FROM users WHERE id = ?").run(id);
      return user;
    });
  }

  findById(id: string) {
    const row = this.storage.connection.prepare<[string], UserRow>(`
      SELECT id, username, password_hash, salt, role_preset, permissions_json,
             server_access_json, created_at, updated_at FROM users WHERE id = ?
    `).get(id);
    return row ? userFromRow(row) : undefined;
  }

  private save(database: Database.Database, value: StoredUser, update: boolean) {
    const user = normalizeStoredUser(value);
    const duplicate = database.prepare<[string, string], { id: string }>(
      "SELECT id FROM users WHERE username = ? COLLATE NOCASE AND id != ?"
    ).get(user.username, user.id);
    if (duplicate) badUserRequest("A user with that username already exists");
    const statement = update
      ? database.prepare(`
        UPDATE users SET username = ?, password_hash = ?, salt = ?, role_preset = ?,
          permissions_json = ?, server_access_json = ?, created_at = ?, updated_at = ?
        WHERE id = ?
      `)
      : database.prepare(`
        INSERT INTO users (
          id, username, password_hash, salt, role_preset, permissions_json,
          server_access_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    const fields = [
      user.username, user.passwordHash, user.salt, user.rolePreset, JSON.stringify(user.permissions),
      user.serverAccess ? JSON.stringify(user.serverAccess) : null, user.createdAt, user.updatedAt
    ];
    if (update) statement.run(...fields, user.id);
    else statement.run(user.id, ...fields);
  }

  private assertHasAdmin() {
    if (!this.list().some(isFullAccessUser)) badUserRequest("At least one admin user is required");
  }

  private notFound(): never {
    const error = new Error("User not found") as Error & { statusCode?: number };
    error.statusCode = 404;
    throw error;
  }
}
