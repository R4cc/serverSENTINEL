import { describe, expect, it } from "vitest";
import { timelineChartInitOptions } from "./EChartsCanvas";

describe("EChartsCanvas", () => {
  it("uses SVG so tooltip movement cannot expose incomplete canvas tiles", () => {
    expect(timelineChartInitOptions).toEqual({ renderer: "svg" });
  });
});
