import type { ThemePreference } from "../../types";

export type ThemeOption = {
  value: ThemePreference;
  label: string;
  mode: "light" | "dark" | "system";
  className?: string;
  family: "classic" | "color";
};

export const themeOptions: readonly ThemeOption[] = [
  { value: "system", label: "System", mode: "system", family: "classic" },
  { value: "light", label: "Light", mode: "light", family: "classic" },
  { value: "dark", label: "Dark", mode: "dark", family: "classic" },
  { value: "xander", label: "Xander Green", mode: "dark", className: "themeXanderGreen", family: "color" },
  { value: "mint", label: "mint", mode: "light", className: "themeMint", family: "color" },
  { value: "nightlight", label: "Nightlight", mode: "dark", className: "themeNightlight", family: "color" },
  { value: "peach", label: "peach", mode: "light", className: "themePeach", family: "color" }
];

export function isThemePreference(value: string | null): value is ThemePreference {
  return themeOptions.some((option) => option.value === value);
}

export function resolveDarkTheme(preference: ThemePreference, systemDark: boolean) {
  const mode = themeOptions.find((option) => option.value === preference)?.mode ?? "light";
  return mode === "dark" || (mode === "system" && systemDark);
}

export function resolvedThemeClassName(preference: ThemePreference, systemDark: boolean) {
  const option = themeOptions.find((candidate) => candidate.value === preference);
  return [resolveDarkTheme(preference, systemDark) ? "themeDark" : "themeLight", option?.className]
    .filter(Boolean)
    .join(" ");
}
