import { validateSafePath } from "../../utils/validation";
import { readExpiringStoredValue, writeExpiringStoredValue } from "../../utils/expiringStorage";
import { navigationStorageDurationMs } from "../../app/navigationStorage";

const fileLocationStoragePrefix = "serversentinel-file-location:";

function storageKey(serverId: string) {
  return `${fileLocationStoragePrefix}${encodeURIComponent(serverId)}`;
}

export function readStoredFileLocation(serverId: string, storage: Storage = window.localStorage, now = Date.now()) {
  if (!serverId) return "/";
  const path = readExpiringStoredValue(storage, storageKey(serverId), navigationStorageDurationMs, now)?.trim() || "/";
  return path.startsWith("/") && !validateSafePath(path) ? path : "/";
}

export function writeStoredFileLocation(serverId: string, path: string, storage: Storage = window.localStorage, now = Date.now()) {
  if (!serverId || !path.startsWith("/") || validateSafePath(path)) return;
  writeExpiringStoredValue(storage, storageKey(serverId), path, now);
}
