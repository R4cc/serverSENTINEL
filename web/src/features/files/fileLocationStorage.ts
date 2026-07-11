import { validateSafePath } from "../../utils/validation";

const fileLocationStoragePrefix = "serversentinel-file-location:";

function storageKey(serverId: string) {
  return `${fileLocationStoragePrefix}${encodeURIComponent(serverId)}`;
}

export function readStoredFileLocation(serverId: string, storage: Storage = window.localStorage) {
  if (!serverId) return "/";
  try {
    const path = storage.getItem(storageKey(serverId))?.trim() || "/";
    return path.startsWith("/") && !validateSafePath(path) ? path : "/";
  } catch {
    return "/";
  }
}

export function writeStoredFileLocation(serverId: string, path: string, storage: Storage = window.localStorage) {
  if (!serverId || !path.startsWith("/") || validateSafePath(path)) return;
  try {
    storage.setItem(storageKey(serverId), path);
  } catch {
    // Browser storage can be unavailable; navigation still works in memory.
  }
}
