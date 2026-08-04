import type { AccentPreference, MotionPreference, ThemePreference } from "../../types";

export type ThemeOption = {
  value: ThemePreference;
  label: string;
  mode: "light" | "dark" | "system";
};

export const themeOptions: readonly ThemeOption[] = [
  { value: "system", label: "System", mode: "system" },
  { value: "light", label: "Light", mode: "light" },
  { value: "dark", label: "Dark", mode: "dark" }
];

export const accentOptions: readonly { value: AccentPreference; label: string }[] = [
  { value: "signal-blue", label: "Signal blue" },
  { value: "pulse-cyan", label: "Pulse cyan" },
  { value: "orbit-violet", label: "Orbit violet" },
  { value: "beacon-amber", label: "Beacon amber" }
];

export const accentPreferenceStorageKey = "serversentinel-accent";
export const motionPreferenceStorageKey = "serversentinel-motion";

export function isThemePreference(value: string | null): value is ThemePreference {
  return themeOptions.some((option) => option.value === value);
}

export function resolveDarkTheme(preference: ThemePreference, systemDark: boolean) {
  const mode = themeOptions.find((option) => option.value === preference)?.mode ?? "light";
  return mode === "dark" || (mode === "system" && systemDark);
}

export function resolvedThemeClassName(preference: ThemePreference, systemDark: boolean) {
  return resolveDarkTheme(preference, systemDark) ? "themeDark" : "themeLight";
}

export function accentPreferenceFromStoredValue(value: string | null): AccentPreference {
  return accentOptions.some((option) => option.value === value) ? value as AccentPreference : "signal-blue";
}

export function motionPreferenceFromStoredValue(value: string | null): MotionPreference {
  return value === "off" ? "off" : "on";
}

function readStoredPreference(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function readAccentPreference() {
  return accentPreferenceFromStoredValue(readStoredPreference(accentPreferenceStorageKey));
}

export function readMotionPreference() {
  return motionPreferenceFromStoredValue(readStoredPreference(motionPreferenceStorageKey));
}

export function resolvedAccentClassName(preference: AccentPreference) {
  return `accent-${preference}`;
}

export function resolvedMotionClassName(preference: MotionPreference) {
  return preference === "off" ? "motion-off" : "motion-on";
}
