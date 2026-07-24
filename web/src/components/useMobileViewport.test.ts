import { describe, expect, it } from "vitest";
import { overviewTimelineQuery, shouldShowOverviewTimeline } from "./useMobileViewport";

describe("Overview timeline visibility", () => {
  it("keeps compact portrait layouts chartless", () => {
    expect(shouldShowOverviewTimeline(390, 844)).toBe(false);
    expect(shouldShowOverviewTimeline(768, 1024)).toBe(false);
  });

  it("shows the large timeline in compact landscape and desktop layouts", () => {
    expect(shouldShowOverviewTimeline(844, 390)).toBe(true);
    expect(shouldShowOverviewTimeline(568, 320)).toBe(true);
    expect(shouldShowOverviewTimeline(981, 1200)).toBe(true);
  });

  it("uses the same desktop-or-landscape rule in the live media query", () => {
    expect(overviewTimelineQuery).toBe("(min-width: 981px), (orientation: landscape)");
  });
});
