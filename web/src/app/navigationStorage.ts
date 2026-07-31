import type { ActivePage } from "../types";
import { readExpiringStoredValue, writeExpiringStoredValue } from "../utils/expiringStorage";

export const navigationStorageDurationMs = 30 * 60 * 1000;

const activePageStorageKey = "serversentinel-active-page";
const activeServerStorageKey = "serversentinel-active-server";
const activePages = new Set<ActivePage>(["settings", "nodes", "create", "overview", "console", "files", "mods", "schedule", "properties"]);

export function readStoredActivePage(storage: Storage = window.localStorage, now = Date.now()): ActivePage {
  const stored = readExpiringStoredValue(storage, activePageStorageKey, navigationStorageDurationMs, now);
  if (stored === "servers") return "nodes";
  return activePages.has(stored as ActivePage) ? stored as ActivePage : "overview";
}

export function writeStoredActivePage(page: ActivePage, storage: Storage = window.localStorage, now = Date.now()) {
  writeExpiringStoredValue(storage, activePageStorageKey, page, now);
}

export function readStoredActiveServerId(storage: Storage = window.localStorage, now = Date.now()) {
  return readExpiringStoredValue(storage, activeServerStorageKey, navigationStorageDurationMs, now) ?? "";
}

export function writeStoredActiveServerId(serverId: string, storage: Storage = window.localStorage, now = Date.now()) {
  writeExpiringStoredValue(storage, activeServerStorageKey, serverId, now);
}
