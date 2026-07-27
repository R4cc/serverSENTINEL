import { describe, expect, it } from "vitest";

import { resourceStatsHistoryWindow, timelineHistoryWindow } from "./overview.js";

describe("overview history retention", () => {
  it("retains resource samples and timeline events for seven days", () => {
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(resourceStatsHistoryWindow).toBe(sevenDays);
    expect(timelineHistoryWindow).toBe(sevenDays);
  });
});
