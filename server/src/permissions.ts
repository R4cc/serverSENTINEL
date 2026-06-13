import type { Permission, RolePreset, StoredUser } from "./types.js";

export const ALL_PERMISSIONS = [
  "servers.view",
  "servers.control",
  "servers.create",
  "servers.delete",
  "servers.editSettings",
  "console.view",
  "console.command",
  "files.view",
  "files.edit",
  "files.delete",
  "files.upload",
  "files.download",
  "mods.view",
  "mods.install",
  "mods.upload",
  "mods.enableDisable",
  "mods.remove",
  "mods.update",
  "schedules.view",
  "schedules.manage",
  "settings.view",
  "integrations.manage",
  "users.view",
  "users.manage"
] as const satisfies readonly Permission[];

const allPermissionSet = new Set<string>(ALL_PERMISSIONS);

const PERMISSION_LABELS: Record<Permission, string> = {
  "servers.view": "view servers",
  "servers.control": "control servers",
  "servers.create": "create servers",
  "servers.delete": "delete servers",
  "servers.editSettings": "edit server settings",
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

export const ROLE_PRESETS: Record<Exclude<RolePreset, "custom">, Permission[]> = {
  viewer: [
    "servers.view",
    "console.view",
    "files.view",
    "mods.view",
    "schedules.view",
    "settings.view"
  ],
  operator: [
    "servers.view",
    "console.view",
    "files.view",
    "mods.view",
    "schedules.view",
    "settings.view",
    "servers.control",
    "console.command"
  ],
  maintainer: [
    "servers.view",
    "console.view",
    "files.view",
    "mods.view",
    "schedules.view",
    "settings.view",
    "servers.control",
    "console.command",
    "mods.install",
    "mods.upload",
    "mods.enableDisable",
    "mods.remove",
    "mods.update",
    "files.edit",
    "files.upload",
    "files.download",
    "schedules.manage"
  ],
  manager: [
    "servers.view",
    "console.view",
    "files.view",
    "mods.view",
    "schedules.view",
    "settings.view",
    "servers.control",
    "console.command",
    "mods.install",
    "mods.upload",
    "mods.enableDisable",
    "mods.remove",
    "mods.update",
    "files.edit",
    "files.upload",
    "files.download",
    "schedules.manage",
    "servers.create",
    "servers.delete",
    "servers.editSettings",
    "files.delete"
  ],
  admin: [...ALL_PERMISSIONS]
};

export const PERMISSION_DEPENDENCIES: Record<Permission, Permission[]> = {
  "servers.view": [],
  "servers.control": ["servers.view"],
  "servers.create": ["servers.view"],
  "servers.delete": ["servers.view"],
  "servers.editSettings": ["servers.view"],
  "console.view": [],
  "console.command": ["console.view"],
  "files.view": [],
  "files.edit": ["files.view"],
  "files.delete": ["files.view"],
  "files.upload": ["files.view"],
  "files.download": ["files.view"],
  "mods.view": [],
  "mods.install": ["mods.view"],
  "mods.upload": ["mods.view"],
  "mods.enableDisable": ["mods.view"],
  "mods.remove": ["mods.view"],
  "mods.update": ["mods.view"],
  "schedules.view": [],
  "schedules.manage": ["schedules.view"],
  "settings.view": [],
  "integrations.manage": ["settings.view"],
  "users.view": [],
  "users.manage": ["users.view"]
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
    if (samePermissions(normalized, ROLE_PRESETS[preset])) {
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
  const order = new Map(ALL_PERMISSIONS.map((permission, index) => [permission, index]));
  return permissions.sort((a, b) => order.get(a)! - order.get(b)!);
}

function samePermissions(a: readonly Permission[], b: readonly Permission[]) {
  const normalizedA = normalizePermissions(a);
  const normalizedB = normalizePermissions(b);
  return normalizedA.length === normalizedB.length && normalizedA.every((permission, index) => permission === normalizedB[index]);
}

function throwPermissionError(message: string, statusCode: number): never {
  const error = new Error(message) as Error & { statusCode?: number };
  error.statusCode = statusCode;
  throw error;
}
