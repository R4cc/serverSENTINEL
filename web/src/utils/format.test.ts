import { describe, expect, it } from "vitest";
import { formatAdaptiveBytes, formatRelativeTimestamp, parseJavaMemoryArgs, parseMaxMemoryGb, readRegionalFormatPreference, regionalFormatPreferenceFromStoredValues, relativeTimestampsFromStoredValue, resolveDisplayTimeZone, resolveRegionalFormatLocale, themePreferenceFromStoredValue } from "./format";

describe("adaptive byte formatting", () => {
  it("selects a readable unit without losing useful precision", () => {
    expect(formatAdaptiveBytes(640)).toBe("640 B");
    expect(formatAdaptiveBytes(1.5 * 1024)).toBe("1.5 KiB");
    expect(formatAdaptiveBytes(748.46 * 1024 * 1024)).toBe("748.46 MiB");
    expect(formatAdaptiveBytes(7.4846 * 1024 * 1024 * 1024)).toBe("7.48 GiB");
    expect(formatAdaptiveBytes(2.25 * 1024 * 1024 * 1024 * 1024)).toBe("2.25 TiB");
  });
});

describe("Java memory argument parsing", () => {
  it("parses initial and maximum heap sizes independently", () => {
    expect(parseJavaMemoryArgs("-Xms512M -Xmx8G")).toEqual({ xmsGb: 1, xmxGb: 8 });
    expect(parseMaxMemoryGb("-Xms2G -Xmx6144M")).toBe(6);
    expect(parseMaxMemoryGb("-Xms2G")).toBe(4);
  });
});

describe("theme preference", () => {
  it("defaults to dark mode while preserving a saved choice", () => {
    expect(themePreferenceFromStoredValue(null)).toBe("dark");
    expect(themePreferenceFromStoredValue("unknown-theme")).toBe("dark");
    expect(themePreferenceFromStoredValue("dark")).toBe("dark");
    expect(themePreferenceFromStoredValue("light")).toBe("light");
    expect(themePreferenceFromStoredValue("system")).toBe("system");
  });
});

describe("display time zone preference", () => {
  it("resolves panel, browser, and UTC choices independently", () => {
    expect(resolveDisplayTimeZone("panel", "Europe/Vienna", "America/New_York")).toBe("Europe/Vienna");
    expect(resolveDisplayTimeZone("browser", "Europe/Vienna", "America/New_York")).toBe("America/New_York");
    expect(resolveDisplayTimeZone("utc", "Europe/Vienna", "America/New_York")).toBe("UTC");
  });
});

describe("regional format preference", () => {
  it("uses the unified preference before legacy values", () => {
    expect(regionalFormatPreferenceFromStoredValues("fr-FR", "en-US", "de-DE")).toBe("fr-FR");
    expect(regionalFormatPreferenceFromStoredValues("invalid", "en-US", "de-DE")).toBe("user");
  });

  it("migrates the date preference first and falls back to the number preference", () => {
    expect(regionalFormatPreferenceFromStoredValues(null, "en-US", "de-DE")).toBe("en-US");
    expect(regionalFormatPreferenceFromStoredValues(null, "user", "de-DE")).toBe("de-DE");
    expect(regionalFormatPreferenceFromStoredValues(null, null, "ja-JP")).toBe("ja-JP");
    expect(regionalFormatPreferenceFromStoredValues(null, "invalid", "invalid")).toBe("user");
  });

  it("falls back to the browser default when storage is unavailable", () => {
    const unavailableStorage = { getItem: () => { throw new Error("Storage unavailable"); } };
    expect(readRegionalFormatPreference(unavailableStorage)).toBe("user");
  });

  it("resolves browser default and explicit locales", () => {
    expect(resolveRegionalFormatLocale("user")).toBeUndefined();
    expect(resolveRegionalFormatLocale("en-GB")).toBe("en-GB");
  });
});

describe("relative timestamp preference", () => {
  it("defaults to relative timestamps and only disables them explicitly", () => {
    expect(relativeTimestampsFromStoredValue(null)).toBe(true);
    expect(relativeTimestampsFromStoredValue("true")).toBe(true);
    expect(relativeTimestampsFromStoredValue("false")).toBe(false);
  });

  it("formats elapsed timestamps in human-readable units", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");

    expect(formatRelativeTimestamp("2026-07-16T11:36:00.000Z", now)).toBe("24 minutes ago");
    expect(formatRelativeTimestamp("2026-07-16T10:00:00.000Z", now)).toBe("2 hours ago");
    expect(formatRelativeTimestamp("2026-07-15T12:00:00.000Z", now)).toBe("1 day ago");
  });
});
