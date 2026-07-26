import { ALL_PERMISSIONS, PERMISSION_DEPENDENCIES, ROLE_PRESETS } from "@serversentinel/contracts";
import type { Permission, RolePreset, StoredUser } from "./types.js";

export { ALL_PERMISSIONS, PERMISSION_DEPENDENCIES, ROLE_PRESETS };

const allPermissionSet = new Set<string>(ALL_PERMISSIONS);
const permissionOrder = new Map<Permission, number>(ALL_PERMISSIONS.map((permission, index) => [permission, index]));

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
  "settings.view": "view settings",
  "integrations.manage": "manage integrations",
  "users.view": "view users",
  "users.manage": "manage users"
};

const normalizedRolePresets: Record<Exclude<RolePreset, "custom">, Permission[]> = {
  viewer: normalizePermissions(ROLE_PRESETS.viewer),
  operator: normalizePermissions(ROLE_PRESETS.operator),
  maintainer: normalizePermissions(ROLE_PRESETS.maintainer),
  manager: normalizePermissions(ROLE_PRESETS.manager),
  admin: normalizePermissions(ROLE_PRESETS.admin)
};

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && allPermissionSet.has(value);
}

export function assertPermission(value: unknown): Permission {
  if (isPermission(value)) return value;
  throwPermissionError(`Unknown permission: ${String(value)}`, 400);
}

export function expandPermissions(permissions: readonly Permission[]) {
  const expanded = new Set<Permission>();
  const visit = (permission: Permission) => {
    if (expanded.has(permission)) return;
    expanded.add(permission);
    for (const dependency of PERMISSION_DEPENDENCIES[permission]) {
      visit(dependency);
    }
  };
  for (const permission of permissions) {
    visit(permission);
  }
  return sortPermissions([...expanded]);
}

export function normalizePermissions(permissions: readonly unknown[]) {
  return expandPermissions(permissions.map(assertPermission));
}

export function inferRolePreset(permissions: readonly Permission[]): RolePreset {
  const normalized = normalizePermissions(permissions);
  for (const preset of ["admin", "manager", "maintainer", "operator", "viewer"] as const) {
    if (samePermissions(normalized, normalizedRolePresets[preset])) {
      return preset;
    }
  }
  return "custom";
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
  return hasPermission(user, "users.manage") && ALL_PERMISSIONS.every((permission) => hasPermission(user, permission));
}

function sortPermissions(permissions: Permission[]) {
  return permissions.sort((a, b) => permissionOrder.get(a)! - permissionOrder.get(b)!);
}

function samePermissions(a: readonly Permission[], b: readonly Permission[]) {
  return a.length === b.length && a.every((permission, index) => permission === b[index]);
}

function throwPermissionError(message: string, statusCode: number): never {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  throw error;
}
