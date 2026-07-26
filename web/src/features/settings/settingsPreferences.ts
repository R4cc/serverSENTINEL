export const consoleHistoryStorageKey = "serversentinel-console-history-enabled";
export const consoleFontSizeStorageKey = "serversentinel-console-font-size";
export const consoleScrollbackStorageKey = "serversentinel-console-scrollback";
export const commandHistoryStorageKey = "serversentinel-command-history";

export const consoleFontSizes = [12, 13, 15, 17] as const;
export const consoleScrollbackSizes = [1_000, 5_000, 10_000, 25_000] as const;

export type ConsoleFontSize = typeof consoleFontSizes[number];
export type ConsoleScrollback = typeof consoleScrollbackSizes[number];

function readStoredValue(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function consoleHistoryEnabledFromStoredValue(value: string | null) {
  return value !== "false";
}

export function consoleFontSizeFromStoredValue(value: string | null): ConsoleFontSize {
  const parsed = Number(value);
  return consoleFontSizes.includes(parsed as ConsoleFontSize) ? parsed as ConsoleFontSize : 13;
}

export function consoleScrollbackFromStoredValue(value: string | null): ConsoleScrollback {
  const parsed = Number(value);
  return consoleScrollbackSizes.includes(parsed as ConsoleScrollback) ? parsed as ConsoleScrollback : 5_000;
}

export function readConsoleHistoryEnabled() {
  return consoleHistoryEnabledFromStoredValue(readStoredValue(consoleHistoryStorageKey));
}

export function readConsoleFontSize() {
  return consoleFontSizeFromStoredValue(readStoredValue(consoleFontSizeStorageKey));
}

export function readConsoleScrollback() {
  return consoleScrollbackFromStoredValue(readStoredValue(consoleScrollbackStorageKey));
}

export function terminalPreferenceOptions(fontSize: ConsoleFontSize, scrollback: ConsoleScrollback) {
  return { fontSize, scrollback };
}

type CommandHistoryStorage = Pick<Storage, "removeItem" | "setItem">;

export function persistCommandHistory(storage: CommandHistoryStorage, history: string[], enabled: boolean) {
  try {
    if (!enabled || history.length === 0) {
      storage.removeItem(commandHistoryStorageKey);
      return;
    }
    storage.setItem(commandHistoryStorageKey, JSON.stringify(history.slice(-50)));
  } catch {
    // Ignore unavailable browser storage; current-session history still works.
  }
}

export function clearStoredCommandHistory(storage: CommandHistoryStorage = window.localStorage) {
  try {
    storage.removeItem(commandHistoryStorageKey);
  } catch {
    // Ignore unavailable browser storage; in-memory history is still cleared.
  }
}
