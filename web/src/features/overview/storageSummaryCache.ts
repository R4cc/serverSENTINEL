import type { ServerStorageSummary } from "../../types";
import { readExpiringStoredValue, writeExpiringStoredValue } from "../../utils/expiringStorage";

/**
 * A cached summary only ever stands in for the live figures until they land, so it may outlive a
 * session. A day keeps it useful across a browser restart without letting the tiles present a
 * measurement nobody has taken recently.
 */
export const storageSummaryCacheDurationMs = 24 * 60 * 60 * 1000;

const storageSummaryCachePrefix = "serversentinel-storage-summary:";

function storageKey(serverId: string) {
  return `${storageSummaryCachePrefix}${encodeURIComponent(serverId)}`;
}

/** Byte counts arrive as null whenever the panel cannot measure them, so anything else is discarded. */
function storedByteCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function readCachedStorageSummary(
  serverId: string,
  storage: Storage = window.localStorage,
  now = Date.now()
): ServerStorageSummary | null {
  if (!serverId) return null;
  const raw = readExpiringStoredValue(storage, storageKey(serverId), storageSummaryCacheDurationMs, now);
  if (!raw) return null;

  try {
    const stored = JSON.parse(raw) as Partial<ServerStorageSummary>;
    const summary: ServerStorageSummary = {
      worldSizeBytes: storedByteCount(stored.worldSizeBytes),
      totalBytes: storedByteCount(stored.totalBytes),
      availableBytes: storedByteCount(stored.availableBytes)
    };
    // An entry with nothing usable left in it would only render "Unavailable", which is
    // already what an absent cache produces.
    return summary.worldSizeBytes === null && summary.totalBytes === null && summary.availableBytes === null
      ? null
      : summary;
  } catch {
    clearCachedStorageSummary(serverId, storage);
    return null;
  }
}

export function writeCachedStorageSummary(
  serverId: string,
  summary: ServerStorageSummary,
  storage: Storage = window.localStorage,
  now = Date.now()
) {
  if (!serverId) return;
  writeExpiringStoredValue(storage, storageKey(serverId), JSON.stringify(summary), now);
}

export function clearCachedStorageSummary(serverId: string, storage: Storage = window.localStorage) {
  if (!serverId) return;
  try {
    storage.removeItem(storageKey(serverId));
  } catch {
    // Browser storage can be denied by policy; the summary still resolves from the live read.
  }
}
