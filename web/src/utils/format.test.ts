import { describe, expect, it } from "vitest";
import { formatTimestampForFilename } from "./format";

describe("configured time zone formatting", () => {
  it("uses the requested zone for timestamped filenames", () => {
    const instant = "2026-07-10T12:34:56.000Z";

    expect(formatTimestampForFilename(instant, "UTC")).toBe("2026-07-10T12-34-56");
    expect(formatTimestampForFilename(instant, "Europe/Vienna")).toBe("2026-07-10T14-34-56");
  });
});
