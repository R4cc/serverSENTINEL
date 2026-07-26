import type { ThemePreference } from "../../types";

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
