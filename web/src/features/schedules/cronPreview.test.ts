import { describe, expect, it } from "vitest";
import { nextCronRunsInTimeZone, zonedWallClockToInstant } from "@serversentinel/contracts";
import { buildCronPreview } from "./cronPreview";

const berlinFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Berlin", dateStyle: "medium", timeStyle: "short" });
const formatBerlin = (value: Date) => berlinFormatter.format(value);

describe("next cron runs in a panel timezone", () => {
  // The browser cannot use its own clock for this: the panel matches cron against the panel's
  // timezone, so a reader in another zone has to be told what the panel will do, not what their
  // own local time would produce.
  it("predicts the panel's local firing times from any other timezone", () => {
    const from = new Date("2026-08-13T00:00:00.000Z");

    const utcRuns = nextCronRunsInTimeZone("0 4 * * *", "UTC", from, 2);
    const berlinRuns = nextCronRunsInTimeZone("0 4 * * *", "Europe/Berlin", from, 2);

    expect(utcRuns.map((run) => run.toISOString())).toEqual([
      "2026-08-13T04:00:00.000Z",
      "2026-08-14T04:00:00.000Z"
    ]);
    // Berlin is UTC+2 in August, so its 04:00 is 02:00Z.
    expect(berlinRuns.map((run) => run.toISOString())).toEqual([
      "2026-08-13T02:00:00.000Z",
      "2026-08-14T02:00:00.000Z"
    ]);
  });

  it("keeps the wall-clock time across a daylight saving change", () => {
    // Central European Summer Time ends on 25 October 2026.
    const runs = nextCronRunsInTimeZone("0 4 * * *", "Europe/Berlin", new Date("2026-10-23T12:00:00.000Z"), 3);

    expect(runs.map((run) => run.toISOString())).toEqual([
      "2026-10-24T02:00:00.000Z",
      "2026-10-25T03:00:00.000Z",
      "2026-10-26T03:00:00.000Z"
    ]);
  });

  it("resolves a wall clock the spring transition skips to the instant the clocks jump to", () => {
    // 02:30 on 29 March 2026 never happens in Berlin; clocks go 02:00 to 03:00.
    const instant = zonedWallClockToInstant({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, "Europe/Berlin");

    expect(instant.toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("respects weekday expressions and returns nothing for an unparseable one", () => {
    const weekdays = nextCronRunsInTimeZone("0 4 * * 1-5", "UTC", new Date("2026-08-14T12:00:00.000Z"), 3);

    // Friday 14 August, then the weekend is skipped.
    expect(weekdays.map((run) => run.toISOString())).toEqual([
      "2026-08-17T04:00:00.000Z",
      "2026-08-18T04:00:00.000Z",
      "2026-08-19T04:00:00.000Z"
    ]);
    expect(nextCronRunsInTimeZone("0 4 * *", "UTC", new Date(), 3)).toEqual([]);
  });
});

describe("cron preview", () => {
  it("names the reader's clock only when it disagrees with the panel's", () => {
    const now = new Date("2026-08-13T00:00:00.000Z");

    const sameZone = buildCronPreview("0 4 * * *", "UTC", "UTC", formatBerlin, now);
    const otherZone = buildCronPreview("0 4 * * *", "UTC", "Europe/Berlin", formatBerlin, now);

    expect(sameZone?.occurrences).toHaveLength(3);
    expect(sameZone?.viewerNote).toBeUndefined();
    // 04:00 UTC is 06:00 in Berlin, which is the contradiction the note exists to resolve.
    expect(otherZone?.viewerNote).toContain("06:00");
    expect(otherZone?.viewerNote).toContain("Europe/Berlin");
  });

  it("has nothing to preview for an invalid expression", () => {
    expect(buildCronPreview("0 4 * *", "UTC", "UTC", formatBerlin)).toBeNull();
  });
});
