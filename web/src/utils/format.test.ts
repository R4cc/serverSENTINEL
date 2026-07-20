import { describe, expect, it } from "vitest";
import { formatRelativeTimestamp, formatTimestampForFilename, readRegionalFormatPreference, regionalFormatPreferenceFromStoredValues, relativeTimestampsFromStoredValue, resolveDisplayTimeZone, resolveRegionalFormatLocale, themePreferenceFromStoredValue } from "./format";

describe("theme preference", () => {
  it("defaults to the system theme while preserving a saved choice", () => {
    expect(themePreferenceFromStoredValue(null)).toBe("system");
    expect(themePreferenceFromStoredValue("unknown-theme")).toBe("system");
    expect(themePreferenceFromStoredValue("dark")).toBe("dark");
  });
});

describe("configured time zone formatting", () => {
  it("uses the requested zone for timestamped filenames", () => {
    const instant = "2026-07-10T12:34:56.000Z";

    expect(formatTimestampForFilename(instant, "UTC")).toBe("2026-07-10T12-34-56");
    expect(formatTimestampForFilename(instant, "Europe/Vienna")).toBe("2026-07-10T14-34-56");
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
