import { ALL_PERMISSIONS, expandPermissions, inferRolePreset, isPermission, ROLE_PRESETS } from "@serversentinel/contracts";
import { throwHttp } from "./http/errors.js";
import type { Permission, RolePreset, StoredUser } from "./types.js";

export { ALL_PERMISSIONS, expandPermissions, inferRolePreset, ROLE_PRESETS };

const PERMISSION_LABELS: Record<Permission, string> = {
  "servers.view": "view servers",
  "servers.control": "control servers",
  "servers.create": "create servers",
  "servers.delete": "delete servers",
  "servers.editSettings": "edit server settings",
  "servers.export": "export server configuration",
  "console.view": "view console",
  "console.command": "send console commands",
  "files.view": "view files",
  "files.edit": "edit files",
  "files.delete": "delete files",
  "files.upload": "upload files",
  "files.download": "download files",
  "mods.view": "view mods",
  "mods.install": "install mods",
  "mods.upload": "upload mods",
  "mods.enableDisable": "enable or disable mods",
  "mods.remove": "remove mods",
  "mods.update": "update mods",
  "schedules.view": "view schedules",
  "schedules.manage": "manage schedules",
  "players.view": "view player insights",
  "players.manage": "configure player insights",
  "settings.view": "view settings",
  "integrations.manage": "manage integrations",
  "users.view": "view users",
  "users.manage": "manage users"
};

function assertPermission(value: unknown): Permission {
  if (isPermission(value)) return value;
  throwPermissionError(`Unknown permission: ${String(value)}`, 400);
}

/** The API rejects a permission it does not recognize rather than dropping it silently. */
export function normalizePermissions(permissions: readonly unknown[]) {
  return expandPermissions(permissions.map(assertPermission));
}

export function permissionsForRolePreset(rolePreset: RolePreset, customPermissions?: readonly unknown[]) {
  if (rolePreset === "custom") {
    return normalizePermissions(customPermissions ?? []);
  }
  return normalizePermissions(ROLE_PRESETS[rolePreset]);
}

export function rolePresetFromUnknown(value: unknown): RolePreset {
  if (value === "viewer" || value === "operator" || value === "maintainer" || value === "manager" || value === "admin" || value === "custom") {
    return value;
  }
  throwPermissionError("Role preset must be one of viewer, operator, maintainer, manager, admin, or custom", 400);
}

export function hasPermission(user: Pick<StoredUser, "permissions">, permission: Permission) {
  return user.permissions.includes(permission);
}

export function requirePermission(permission: Permission) {
  return (user: Pick<StoredUser, "permissions">) => {
    if (!hasPermission(user, permission)) {
      throwPermissionError(`You need permission to ${PERMISSION_LABELS[permission]} before performing this action.`, 403);
    }
  };
}

export function isFullAccessUser(user: Pick<StoredUser, "permissions">) {
  return ALL_PERMISSIONS.every((permission) => hasPermission(user, permission));
}

/** Both sides must come from normalizePermissions, which sorts into a stable order. */
export function samePermissions(a: readonly Permission[], b: readonly Permission[]) {
  return a.length === b.length && a.every((permission, index) => permission === b[index]);
}

function throwPermissionError(message: string, statusCode: number): never {
  throwHttp(statusCode, message);
}
