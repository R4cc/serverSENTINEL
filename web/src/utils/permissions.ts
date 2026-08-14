import { ALL_PERMISSIONS, expandPermissions, inferRolePreset, isPermission, PERMISSION_DEPENDENCIES, ROLE_PRESETS } from "@serversentinel/contracts";
import type { PermissionKey, PublicUser, RolePreset } from "../types";

export { expandPermissions, inferRolePreset, PERMISSION_DEPENDENCIES };

export const PERMISSION_GROUPS: Array<{ title: string; permissions: Array<{ key: PermissionKey; label: string }> }> = [
  {
    title: "Server",
    permissions: [
      { key: "servers.view", label: "View servers" },
      { key: "servers.control", label: "Start / stop / restart servers" },
      { key: "servers.create", label: "Create servers" },
      { key: "servers.delete", label: "Delete servers" },
      { key: "servers.editSettings", label: "Edit server properties" },
      { key: "servers.export", label: "Export server configuration" }
    ]
  },
  {
    title: "Console",
    permissions: [
      { key: "console.view", label: "View console logs" },
      { key: "console.command", label: "Send console commands" }
    ]
  },
  {
    title: "Files",
    permissions: [
      { key: "files.view", label: "View files" },
      { key: "files.edit", label: "Edit files" },
      { key: "files.upload", label: "Upload files" },
      { key: "files.download", label: "Download files" },
      { key: "files.delete", label: "Delete files" }
    ]
  },
  {
    title: "Mods and plugins",
    permissions: [
      { key: "mods.view", label: "View mods and plugins" },
      { key: "mods.install", label: "Install from Modrinth" },
      { key: "mods.upload", label: "Upload mod and plugin jars" },
      { key: "mods.enableDisable", label: "Enable / disable mods and plugins" },
      { key: "mods.remove", label: "Remove mods and plugins" },
      { key: "mods.update", label: "Update mods and plugins" }
    ]
  },
  {
    title: "Schedules",
    permissions: [
      { key: "schedules.view", label: "View schedules" },
      { key: "schedules.manage", label: "Manage schedules" }
    ]
  },
  {
    title: "Administration",
    permissions: [
      { key: "users.view", label: "View users" },
      { key: "users.manage", label: "Manage users" },
      { key: "integrations.manage", label: "Manage integrations / API keys" }
    ]
  }
];

export { isPermission as isPermissionKey };

/** The browser drops anything it does not recognize; the API is what refuses an unknown key. */
export function normalizePermissions(permissions: readonly string[]) {
  return expandPermissions(permissions.filter(isPermission));
}

export function permissionsForPreset(preset: RolePreset) {
  return preset === "custom" ? [] : expandPermissions(ROLE_PRESETS[preset]);
}

/**
 * Derived permissions are read many times per render (every `can*` flag on every page), so cache the
 * expansion per user object. The entry is invalidated when `user.permissions` is replaced, and the
 * cached array is never handed out directly — callers get a copy so they stay free to mutate it.
 */
const derivedPermissionsCache = new WeakMap<PublicUser, {
  source: readonly string[];
  ordered: PermissionKey[];
  lookup: Set<PermissionKey>;
}>();

const emptyDerivedPermissions = {
  ordered: [] as PermissionKey[],
  lookup: new Set<PermissionKey>()
};

function derivedPermissions(user?: PublicUser | null) {
  if (!user) return emptyDerivedPermissions;
  const source = user.permissions ?? [];
  const cached = derivedPermissionsCache.get(user);
  if (cached && cached.source === source) return cached;
  const ordered = normalizePermissions(source);
  const entry = { source, ordered, lookup: new Set(ordered) };
  derivedPermissionsCache.set(user, entry);
  return entry;
}

export function userPermissions(user?: PublicUser | null) {
  return [...derivedPermissions(user).ordered];
}

export function hasPermission(user: PublicUser | null | undefined, permission: PermissionKey) {
  return derivedPermissions(user).lookup.has(permission);
}

type FileManagerPermission = "view" | "download" | "edit" | "rename" | "upload" | "duplicate" | "delete";

export function isModsPublicPath(path: string) {
  const normalized = normalizePublicPath(path);
  return normalized === "/mods" || normalized.startsWith("/mods/") || normalized === "/plugins" || normalized.startsWith("/plugins/");
}

export function isServerPropertiesPath(path: string) {
  return normalizePublicPath(path) === "/server.properties";
}

export function fileManagerPermissionForPath(path: string, action: FileManagerPermission): PermissionKey {
  if (isModsPublicPath(path)) {
    if (action === "view" || action === "download") return "mods.view";
    if (action === "edit" || action === "rename") return "mods.enableDisable";
    if (action === "upload" || action === "duplicate") return "mods.upload";
    return "mods.remove";
  }
  if ((action === "edit" || action === "rename") && isServerPropertiesPath(path)) {
    return "servers.editSettings";
  }
  if (action === "view") return "files.view";
  if (action === "download") return "files.download";
  if (action === "edit" || action === "rename") return "files.edit";
  if (action === "upload" || action === "duplicate") return "files.upload";
  return "files.delete";
}

export function hasFileManagerPermission(user: PublicUser | null | undefined, path: string, action: FileManagerPermission) {
  return hasPermission(user, fileManagerPermissionForPath(path, action));
}

export function rolePresetLabel(rolePreset?: RolePreset) {
  switch (rolePreset) {
    case "viewer":
      return "Viewer";
    case "operator":
      return "Operator";
    case "maintainer":
      return "Maintainer";
    case "manager":
      return "Manager";
    case "admin":
      return "Admin";
    default:
      return "Custom";
  }
}

export function displayedRolePreset(user: PublicUser) {
  const permissions = userPermissions(user);
  return inferRolePreset(permissions);
}

export function dependentPermissions(basePermission: PermissionKey) {
  return ALL_PERMISSIONS.filter((permission) => PERMISSION_DEPENDENCIES[permission].includes(basePermission));
}

function normalizePublicPath(path: string) {
  const value = path.trim();
  if (!value) return "/";
  return value.startsWith("/") ? value.replace(/\/+/g, "/") : `/${value.replace(/\/+/g, "/")}`;
}
