import { describe, expect, it } from "vitest";
import type { PlayerLatencyPoint } from "../../types";
import {
  buildConnectionQualityChartOption,
  connectionQualityCeiling,
  connectionQualityTimeFormatters,
  connectionQualityTooltipHtml,
  defaultConnectionQualityPalette
} from "./connectionQualityChartOptions";

const points: PlayerLatencyPoint[] = [
  { at: Date.parse("2026-08-15T12:00:00.000Z"), medianPingMs: 40, p95PingMs: 70, players: 2, measuredPlayers: 2 },
  { at: Date.parse("2026-08-15T18:00:00.000Z"), players: 0, measuredPlayers: 0 },
  { at: Date.parse("2026-08-16T12:00:00.000Z"), medianPingMs: 45, p95PingMs: 150, players: 3, measuredPlayers: 3 }
];

describe("connection quality chart", () => {
  it("adds useful headroom and formats multi-day axes as dates", () => {
    expect(connectionQualityCeiling(points)).toBe(175);
    const formatters = connectionQualityTimeFormatters("UTC", points[0].at, points.at(-1)!.at);
    expect(formatters.axis(points[0].at)).toContain("12:00");
    expect(formatters.axis(points[0].at)).toContain("15 Aug");
    expect(formatters.axis(points.at(-1)!.at)).toContain("16 Aug");
    expect(formatters.tooltip(points.at(-1)!.at)).toContain("16 Aug");
    expect(formatters.tooltip(points.at(-1)!.at)).toContain("12:00");
  });

  it("uses the shared time axis, preserves unknown gaps, and exposes both series", () => {
    const option = buildConnectionQualityChartOption({ points, timeZone: "UTC", compact: false, palette: defaultConnectionQualityPalette });
    const xAxis = option.xAxis as { type: string; min: number; max: number };
    const yAxis = option.yAxis as { splitLine: { lineStyle: { type: string } } };
    const tooltip = option.tooltip as { axisPointer: { lineStyle: { type: string } } };
    const series = option.series as Array<{ id: string; name: string; connectNulls: boolean; data: unknown[][] }>;

    expect(xAxis).toMatchObject({ type: "time", min: points[0].at, max: points.at(-1)!.at });
    expect(yAxis.splitLine.lineStyle.type).toBe("solid");
    expect(tooltip.axisPointer.lineStyle.type).toBe("solid");
    expect(series.map((entry) => entry.name)).toEqual(["Median ping", "95th percentile"]);
    expect(series.every((entry) => entry.connectNulls === false)).toBe(true);
    expect(series[0].data[1]).toEqual([points[1].at, "-", 0]);
  });

  it("writes a safe, useful hover readout", () => {
    const html = connectionQualityTooltipHtml([
      { axisValue: points[2].at, seriesName: "Median ping", value: [points[2].at, 45, 3], color: "#2c7a66" },
      { axisValue: points[2].at, seriesName: "95th < percentile", value: [points[2].at, 150, 3], color: "#4169ff" }
    ], () => "16 Aug, 12:00");

    expect(html).toContain("16 Aug, 12:00");
    expect(html).toContain("45 ms");
    expect(html).toContain("150 ms");
    expect(html).toContain("3 active players");
    expect(html).toContain("95th &lt; percentile");
    expect(html).not.toContain("95th < percentile");
  });
});
