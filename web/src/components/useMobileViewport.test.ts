import { describe, expect, it } from "vitest";
import { overviewTimelineQuery } from "./useMobileViewport";

describe("Overview timeline visibility", () => {
  it("uses the same desktop-or-landscape rule in the live media query", () => {
    expect(overviewTimelineQuery).toBe("(min-width: 981px), (orientation: landscape)");
  });
});
