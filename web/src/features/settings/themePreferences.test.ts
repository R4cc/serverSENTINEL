import { describe, expect, it } from "vitest";
import { isThemePreference, resolvedThemeClassName, resolveDarkTheme, themeOptions } from "./themePreferences";

describe("theme preferences", () => {
  it("keeps every stored theme value discoverable", () => {
    for (const option of themeOptions) expect(isThemePreference(option.value)).toBe(true);
    expect(isThemePreference("hot-dog-stand")).toBe(false);
  });

  it("resolves fixed and system color modes", () => {
    expect(resolveDarkTheme("dark", false)).toBe(true);
    expect(resolveDarkTheme("light", true)).toBe(false);
    expect(resolveDarkTheme("system", true)).toBe(true);
    expect(resolveDarkTheme("system", false)).toBe(false);
  });

  it("maps the resolved mode onto a contrast class", () => {
    expect(resolvedThemeClassName("dark", false)).toBe("themeDark");
    expect(resolvedThemeClassName("light", true)).toBe("themeLight");
    expect(resolvedThemeClassName("system", true)).toBe("themeDark");
  });
});
