/**
 * Reads and writes of `localStorage` that never throw. Storage can be disabled, full, or blocked in
 * a private window, and a preference that cannot be read must fall back rather than break the page.
 * Callers decide the fallback from the `null` this returns.
 */
export function readStoredValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Best effort: when storage is unavailable the value still applies in memory for this session. */
export function writeStoredValue(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore unavailable browser storage; in-memory preferences still apply.
  }
}
