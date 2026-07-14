import { describe, expect, it } from "vitest";
import {
  consoleFontSizeFromStoredValue,
  consoleHistoryEnabledFromStoredValue,
  consoleScrollbackFromStoredValue,
  commandHistoryStorageKey,
  clearStoredCommandHistory,
  persistCommandHistory,
  terminalPreferenceOptions
} from "./settingsPreferences";

describe("settings console preferences", () => {
  it("preserves the existing console defaults", () => {
    expect(consoleHistoryEnabledFromStoredValue(null)).toBe(true);
    expect(consoleFontSizeFromStoredValue(null)).toBe(13);
    expect(consoleScrollbackFromStoredValue(null)).toBe(5_000);
  });

  it("accepts supported stored values", () => {
    expect(consoleHistoryEnabledFromStoredValue("false")).toBe(false);
    expect(consoleFontSizeFromStoredValue("17")).toBe(17);
    expect(consoleScrollbackFromStoredValue("25000")).toBe(25_000);
    expect(terminalPreferenceOptions(15, 10_000)).toEqual({ fontSize: 15, scrollback: 10_000 });
  });

  it("falls back safely when storage is invalid", () => {
    expect(consoleHistoryEnabledFromStoredValue("not-a-boolean")).toBe(true);
    expect(consoleFontSizeFromStoredValue("14")).toBe(13);
    expect(consoleFontSizeFromStoredValue("large")).toBe(13);
    expect(consoleScrollbackFromStoredValue("999999")).toBe(5_000);
  });

  it("forgets persisted history without clearing the current-session array", () => {
    const values = new Map<string, string>([[commandHistoryStorageKey, '["old command"]']]);
    const storage = {
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    };
    const sessionHistory = ["list", "say hello"];

    persistCommandHistory(storage, sessionHistory, false);

    expect(values.has(commandHistoryStorageKey)).toBe(false);
    expect(sessionHistory).toEqual(["list", "say hello"]);
  });

  it("caps saved history and supports explicit clearing", () => {
    const values = new Map<string, string>();
    const storage = {
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    };

    persistCommandHistory(storage, Array.from({ length: 55 }, (_, index) => `command ${index}`), true);
    expect(JSON.parse(values.get(commandHistoryStorageKey) || "[]")).toHaveLength(50);

    clearStoredCommandHistory(storage);
    expect(values.has(commandHistoryStorageKey)).toBe(false);
  });
});
