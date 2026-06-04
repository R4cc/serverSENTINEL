import { useEffect, useState } from "react";
import { initialDemoFiles, initialDemoMods, initialDemoSchedules } from "../demo";
import type { InstalledMod, LocalePreference, ScheduledExecution, ThemePreference } from "../types";
import { readLocalePreference, readThemePreference } from "../utils/format";

function readDemoMode() {
  return window.localStorage.getItem("serversentinel-demo-mode") === "true";
}

export function usePreferencesState() {
  const [themePreference, setThemePreference] = useState<ThemePreference>(() => readThemePreference());
  const [demoMode, setDemoMode] = useState(() => readDemoMode());
  const [dateLocalePreference, setDateLocalePreference] = useState<LocalePreference>(() => readLocalePreference("serversentinel-date-locale"));
  const [numberLocalePreference, setNumberLocalePreference] = useState<LocalePreference>(() => readLocalePreference("serversentinel-number-locale"));
  const [demoRunning, setDemoRunning] = useState(true);
  const [demoFiles, setDemoFiles] = useState<Record<string, string>>(() => initialDemoFiles);
  const [demoInstalledMods, setDemoInstalledMods] = useState<InstalledMod[]>(() => initialDemoMods);
  const [demoSchedules, setDemoSchedules] = useState<ScheduledExecution[]>(() => initialDemoSchedules);
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false);

  useEffect(() => {
    window.localStorage.setItem("serversentinel-demo-mode", String(demoMode));
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
    window.localStorage.setItem("serversentinel-theme", themePreference);
  }, [themePreference]);

  useEffect(() => {
    window.localStorage.setItem("serversentinel-date-locale", dateLocalePreference);
  }, [dateLocalePreference]);

  useEffect(() => {
    window.localStorage.setItem("serversentinel-number-locale", numberLocalePreference);
  }, [numberLocalePreference]);

  return {
    themePreference,
    setThemePreference,
    demoMode,
    setDemoMode,
    dateLocalePreference,
    setDateLocalePreference,
    numberLocalePreference,
    setNumberLocalePreference,
    demoRunning,
    setDemoRunning,
    demoFiles,
    setDemoFiles,
    demoInstalledMods,
    setDemoInstalledMods,
    demoSchedules,
    setDemoSchedules,
    systemDark
  };
}
