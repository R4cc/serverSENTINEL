import { describe, expect, it } from "vitest";
import { isThemePreference, resolvedThemeClassName, resolveDarkTheme, themeOptions } from "./themePreferences";

describe("theme preferences", () => {
  it("keeps every stored theme value discoverable", () => {
    for (const option of themeOptions) expect(isThemePreference(option.value)).toBe(true);
    expect(isThemePreference("hot-dog-stand")).toBe(false);
  });

  it("resolves fixed and system color modes", () => {
    expect(resolveDarkTheme("xander", false)).toBe(true);
    expect(resolveDarkTheme("nightlight", false)).toBe(true);
    expect(resolveDarkTheme("mint", true)).toBe(false);
    expect(resolveDarkTheme("peach", true)).toBe(false);
    expect(resolveDarkTheme("system", true)).toBe(true);
    expect(resolveDarkTheme("system", false)).toBe(false);
  });

  it("combines the contrast mode with the selected palette class", () => {
    expect(resolvedThemeClassName("xander", false)).toBe("themeDark themeXanderGreen");
    expect(resolvedThemeClassName("mint", true)).toBe("themeLight themeMint");
    expect(resolvedThemeClassName("dark", false)).toBe("themeDark");
  });
});
