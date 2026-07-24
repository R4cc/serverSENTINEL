type StoredValue = {
  value: string;
  savedAt: number;
};

function removeStoredValue(storage: Storage, key: string) {
  try {
    storage.removeItem(key);
  } catch {
    // Browser storage can be unavailable; callers still receive their fallback.
  }
}

export function readExpiringStoredValue(storage: Storage, key: string, durationMs: number, now = Date.now()) {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;

    const stored = JSON.parse(raw) as Partial<StoredValue>;
    const age = now - (stored.savedAt ?? Number.NaN);
    if (typeof stored.value !== "string" || !Number.isFinite(age) || age < 0 || age >= durationMs) {
      removeStoredValue(storage, key);
      return null;
    }

    return stored.value;
  } catch {
    removeStoredValue(storage, key);
    return null;
  }
}

export function writeExpiringStoredValue(storage: Storage, key: string, value: string, now = Date.now()) {
  try {
    storage.setItem(key, JSON.stringify({ value, savedAt: now } satisfies StoredValue));
  } catch {
    // Browser storage can be unavailable; the value still works in memory.
  }
}
