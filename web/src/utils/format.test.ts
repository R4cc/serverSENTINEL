import { describe, expect, it } from "vitest";
import { formatTimestampForFilename, resolveDisplayTimeZone } from "./format";

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
