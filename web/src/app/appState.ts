import { useEffect, useState } from "react";
import { initialDemoFiles, initialDemoSchedules } from "../demo";
import { modsForDemoFixture, readModsDemoFixture } from "../features/mods/modsDemoFixtures";
import type { DisplayTimeZonePreference, InstalledMod, RegionalFormatPreference, ScheduledExecution, ThemePreference } from "../types";
import { readDisplayTimeZonePreference, readRegionalFormatPreference, readRelativeTimestampsPreference, readThemePreference } from "../utils/format";
import { readStoredDemoMode, writeStoredDemoMode } from "./appConfig";
import {
  clearStoredCommandHistory,
  consoleFontSizeStorageKey,
  consoleHistoryStorageKey,
  consoleScrollbackStorageKey,
  readConsoleFontSize,
  readConsoleHistoryEnabled,
  readConsoleScrollback
} from "../features/settings/settingsPreferences";

function writePreference(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore unavailable browser storage; in-memory preferences still apply.
  }
}

export function usePreferencesState() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());
  const [demoMode, setDemoMode] = useState(() => readStoredDemoMode());
  const [regionalFormatPreference, setRegionalFormatPreference] = useState<RegionalFormatPreference>(() => readRegionalFormatPreference());
  const [displayTimeZonePreference, setDisplayTimeZonePreference] = useState<DisplayTimeZonePreference>(() => readDisplayTimeZonePreference());
  const [relativeTimestamps, setRelativeTimestamps] = useState(() => readRelativeTimestampsPreference());
  const [rememberConsoleHistory, setRememberConsoleHistory] = useState(() => readConsoleHistoryEnabled());
  const [consoleFontSize, setConsoleFontSize] = useState(() => readConsoleFontSize());
  const [consoleScrollback, setConsoleScrollback] = useState(() => readConsoleScrollback());
  const [demoRunning, setDemoRunning] = useState(true);
  const [demoFiles, setDemoFiles] = useState<Record<string, string>>(() => ({ ...initialDemoFiles }));
  const [demoInstalledMods, setDemoInstalledMods] = useState<InstalledMod[]>(() => modsForDemoFixture(readModsDemoFixture()));
  const [demoSchedules, setDemoSchedules] = useState<ScheduledExecution[]>(() => initialDemoSchedules.map((schedule) => ({ ...schedule })));
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);

  useEffect(() => {
    writeStoredDemoMode(demoMode);
  }, [demoMode]);

  useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const update = () => setSystemDark(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    writePreference("serversentinel-theme", themePreference);
  }, [themePreference]);

  useEffect(() => {
    writePreference("serversentinel-regional-format", regionalFormatPreference);
  }, [regionalFormatPreference]);

  useEffect(() => {
    writePreference("serversentinel-display-time-zone", displayTimeZonePreference);
  }, [displayTimeZonePreference]);

  useEffect(() => {
    writePreference("serversentinel-relative-timestamps", String(relativeTimestamps));
  }, [relativeTimestamps]);

  useEffect(() => {
    writePreference(consoleHistoryStorageKey, String(rememberConsoleHistory));
    if (!rememberConsoleHistory) clearStoredCommandHistory();
  }, [rememberConsoleHistory]);

  useEffect(() => {
    writePreference(consoleFontSizeStorageKey, String(consoleFontSize));
  }, [consoleFontSize]);

  useEffect(() => {
    writePreference(consoleScrollbackStorageKey, String(consoleScrollback));
  }, [consoleScrollback]);

  function resetDemoState() {
    setDemoRunning(true);
    setDemoFiles({ ...initialDemoFiles });
    setDemoInstalledMods(modsForDemoFixture(readModsDemoFixture()));
    setDemoSchedules(initialDemoSchedules.map((schedule) => ({ ...schedule })));
  }

  return {
    themePreference,
    setThemePreference,
    demoMode,
    setDemoMode,
    regionalFormatPreference,
    setRegionalFormatPreference,
    displayTimeZonePreference,
    setDisplayTimeZonePreference,
    relativeTimestamps,
    setRelativeTimestamps,
    rememberConsoleHistory,
    setRememberConsoleHistory,
    consoleFontSize,
    setConsoleFontSize,
    consoleScrollback,
    setConsoleScrollback,
    demoRunning,
    setDemoRunning,
    demoFiles,
    setDemoFiles,
    demoInstalledMods,
    setDemoInstalledMods,
    demoSchedules,
    setDemoSchedules,
    resetDemoState,
    systemDark
  };
}
