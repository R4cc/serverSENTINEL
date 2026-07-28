import { ALL_PERMISSIONS, PERMISSION_DEPENDENCIES, ROLE_PRESETS } from "@serversentinel/contracts";
import type { PermissionKey, PublicUser, RolePreset } from "../types";

export { PERMISSION_DEPENDENCIES };

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

const knownPermissions = new Set<string>(ALL_PERMISSIONS);
const permissionOrder = new Map(ALL_PERMISSIONS.map((permission, index) => [permission, index]));

export function isPermissionKey(value: unknown): value is PermissionKey {
  return typeof value === "string" && knownPermissions.has(value);
}

export function expandPermissions(permissions: readonly PermissionKey[]) {
  const expanded = new Set<PermissionKey>();
  const visit = (permission: PermissionKey) => {
    if (expanded.has(permission)) return;
    expanded.add(permission);
    for (const dependency of PERMISSION_DEPENDENCIES[permission]) visit(dependency);
  };
  permissions.forEach(visit);
  return sortPermissions([...expanded]);
}

export function normalizePermissions(permissions: readonly string[]) {
  return expandPermissions(permissions.filter(isPermissionKey));
}

const ROLE_PRESET_ORDER = ["admin", "manager", "maintainer", "operator", "viewer"] as const;

/** `ROLE_PRESETS` is constant, so normalize each preset once instead of on every comparison. */
const normalizedRolePresets = new Map<RolePreset, PermissionKey[]>(
  ROLE_PRESET_ORDER.map((preset) => [preset, normalizePermissions(ROLE_PRESETS[preset])])
);

export function inferRolePreset(permissions: readonly PermissionKey[]): RolePreset {
  const normalized = normalizePermissions(permissions);
  for (const preset of ROLE_PRESET_ORDER) {
    if (samePermissions(normalized, normalizedRolePresets.get(preset)!)) return preset;
  }
  return "custom";
}

export function permissionsForPreset(preset: RolePreset) {
  return preset === "custom" ? [] : [...normalizedRolePresets.get(preset)!];
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

function derivedPermissions(user?: PublicUser | null) {
  if (!user) return { ordered: [] as PermissionKey[], lookup: new Set<PermissionKey>() };
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

export type FileManagerPermission = "view" | "download" | "edit" | "rename" | "upload" | "duplicate" | "delete";

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

function sortPermissions(permissions: PermissionKey[]) {
  return permissions.sort((a, b) => permissionOrder.get(a)! - permissionOrder.get(b)!);
}

function samePermissions(a: readonly PermissionKey[], b: readonly PermissionKey[]) {
  const normalizedA = normalizePermissions(a);
  const normalizedB = normalizePermissions(b);
  return normalizedA.length === normalizedB.length && normalizedA.every((permission, index) => permission === normalizedB[index]);
}

function normalizePublicPath(path: string) {
  const value = path.trim();
  if (!value) return "/";
  return value.startsWith("/") ? value.replace(/\/+/g, "/") : `/${value.replace(/\/+/g, "/")}`;
}
