import type { PermissionKey, PublicUser, RolePreset } from "../types";

const ALL_PERMISSIONS = [
  "servers.view",
  "servers.control",
  "servers.create",
  "servers.delete",
  "servers.editSettings",
  "servers.export",
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
] as const satisfies readonly PermissionKey[];

const ROLE_PRESETS: Record<Exclude<RolePreset, "custom">, PermissionKey[]> = {
  viewer: ["servers.view", "console.view", "files.view", "mods.view", "schedules.view", "settings.view"],
  operator: ["servers.view", "console.view", "files.view", "mods.view", "schedules.view", "settings.view", "servers.control", "console.command"],
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
    "servers.export",
    "files.delete"
  ],
  admin: [...ALL_PERMISSIONS]
};

export const PERMISSION_DEPENDENCIES: Record<PermissionKey, PermissionKey[]> = {
  "servers.view": [],
  "servers.control": ["servers.view"],
  "servers.create": ["servers.view"],
  "servers.delete": ["servers.view"],
  "servers.editSettings": ["servers.view"],
  "servers.export": ["servers.view"],
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

export function inferRolePreset(permissions: readonly PermissionKey[]): RolePreset {
  const normalized = normalizePermissions(permissions);
  for (const preset of ["admin", "manager", "maintainer", "operator", "viewer"] as const) {
    if (samePermissions(normalized, ROLE_PRESETS[preset])) return preset;
  }
  return "custom";
}

export function permissionsForPreset(preset: RolePreset) {
  return preset === "custom" ? [] : normalizePermissions(ROLE_PRESETS[preset]);
}

export function userPermissions(user?: PublicUser | null) {
  return normalizePermissions(user?.permissions ?? []);
}

export function hasPermission(user: PublicUser | null | undefined, permission: PermissionKey) {
  return userPermissions(user).includes(permission);
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
  const order = new Map(ALL_PERMISSIONS.map((permission, index) => [permission, index]));
  return permissions.sort((a, b) => order.get(a)! - order.get(b)!);
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
