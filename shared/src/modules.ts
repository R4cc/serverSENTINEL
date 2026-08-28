import type { Permission } from "./index.js";

/**
 * Optional first-party features. The core panel — nodes, servers, console, files, properties,
 * settings — is never a module and is always present; a module is a feature an installation can
 * switch off without losing anything else.
 *
 * Two independent gates decide whether a module reaches a person:
 *
 * 1. The installation gate. An administrator turns the module on or off for the whole panel. The
 *    panel stops its background work and refuses its endpoints while it is off.
 * 2. The user gate. `accessPermission` is an ordinary permission, so the existing role presets and
 *    per-user grants already decide who may see the module. Nothing new has to be administered.
 *
 * The browser uses both gates to decide whether to download the module's code at all, but that is
 * an optimization. The panel enforces the same two gates on every request and is the only authority.
 */
export type ModuleId = "schedules" | "managedContent" | "playerInsights";

export type ModuleDescriptor = {
  id: ModuleId;
  label: string;
  /** One line describing what the module does, shown beside its toggle. */
  summary: string;
  /** What stops happening while the module is off, and what survives being turned off. */
  disabledEffect: string;
  /** The permission a user needs before the module is visible to them at all. */
  accessPermission: Permission;
  /** Every permission the module owns, so settings can explain who gets to use it. */
  permissions: readonly Permission[];
};

export const MODULE_DESCRIPTORS = [
  {
    id: "schedules",
    label: "Schedules",
    summary: "Cron-driven maintenance: timed restarts, console commands, and the history of every run.",
    disabledEffect: "Nothing is scheduled while this is off and the Schedules workspace is hidden. Existing schedules and their run history are kept, and resume on their next due time when it is switched back on.",
    accessPermission: "schedules.view",
    permissions: ["schedules.view", "schedules.manage"]
  },
  {
    id: "managedContent",
    label: "Managed content",
    summary: "Mods and plugins: the installed list, Modrinth search and installs, and automatic update checks.",
    disabledEffect: "The Mods workspace, Modrinth browsing, and the hourly update check all stop. Installed mods and plugins are left exactly where they are — servers keep loading them, and they are managed again as soon as this is switched back on.",
    accessPermission: "mods.view",
    permissions: ["mods.view", "mods.install", "mods.upload", "mods.enableDisable", "mods.remove", "mods.update"]
  },
  {
    id: "playerInsights",
    label: "Player insights",
    summary: "Where players connect from: local GeoLite2 lookups, regional spread, estimated latency, and quiet maintenance hours.",
    disabledEffect: "The Players workspace, its API, the GeoLite2 database refresh, and the lookup that turns a join into a location all stop. The geography already derived is kept, and analytics resume from it when this is switched back on. No player address is stored either way.",
    accessPermission: "players.view",
    permissions: ["players.view", "players.manage"]
  }
] as const satisfies readonly ModuleDescriptor[];

export const MODULE_IDS = MODULE_DESCRIPTORS.map((descriptor) => descriptor.id) as readonly ModuleId[];

const descriptorsById = new Map<ModuleId, ModuleDescriptor>(
  MODULE_DESCRIPTORS.map((descriptor) => [descriptor.id, descriptor])
);

export function isModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && descriptorsById.has(value as ModuleId);
}

export function moduleDescriptor(id: ModuleId): ModuleDescriptor {
  return descriptorsById.get(id)!;
}

/**
 * One module as a client sees it.
 *
 * `enabled` is the administrator's setting and is the same for everyone: it is what the Modules
 * settings shows and what survives a restart. `accessible` is whether this viewer can actually use
 * the module right now, and is what the UI keys off. They differ when the viewer lacks the
 * permission, and also when the module is switched on but its background work is not running —
 * a panel that cannot serve a module should not offer it, while still showing the operator the
 * setting they chose.
 */
export type ModuleAccessState = {
  id: ModuleId;
  enabled: boolean;
  accessible: boolean;
};

export function moduleAccessStates(gates: {
  isEnabled(id: ModuleId): boolean;
  /** Defaults to `isEnabled`, for callers with no notion of a module failing to run. */
  isServing?(id: ModuleId): boolean;
  hasPermission(permission: Permission): boolean;
}): ModuleAccessState[] {
  return MODULE_DESCRIPTORS.map((descriptor) => {
    const enabled = gates.isEnabled(descriptor.id);
    const serving = gates.isServing?.(descriptor.id) ?? enabled;
    return {
      id: descriptor.id,
      enabled,
      accessible: serving && gates.hasPermission(descriptor.accessPermission)
    };
  });
}

/**
 * Absent state means "not known yet", which is treated as no access: the browser would rather
 * withhold a module for the moment the panel takes to answer than fetch code for a module the
 * installation has switched off.
 */
export function isModuleAccessible(states: readonly ModuleAccessState[] | undefined, id: ModuleId) {
  return states?.find((state) => state.id === id)?.accessible === true;
}

export function isModuleEnabled(states: readonly ModuleAccessState[] | undefined, id: ModuleId) {
  return states?.find((state) => state.id === id)?.enabled === true;
}
