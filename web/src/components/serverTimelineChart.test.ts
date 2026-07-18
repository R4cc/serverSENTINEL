import { describe, expect, it } from "vitest";
import type { ServerTimelineResourcePoint } from "../types";
import type { MarkerCluster, SeriesKey } from "./ServerTimeline";
import {
  buildTimelineChartOption,
  adaptiveMemoryAxisBounds,
  dataZoomWindow,
  defaultTimelinePalette,
  escapeTimelineHtml,
  liveTimelineWindow,
  nearestTimelineSample,
  timelineHoverTooltipHtml,
  timelineNeedsRefill,
  timelineQueryWindow,
  timelineRetentionMs,
  timelineTooltipHtml
} from "./serverTimelineChart";

const enabled: Record<SeriesKey, boolean> = {
  cpuUtilizationPercent: true,
  memoryUtilizationPercent: true,
  networkRxBytesPerSecond: true,
  networkTxBytesPerSecond: true,
  playersOnline: false
};

const sample: ServerTimelineResourcePoint = {
  sampledAt: 10_000,
  available: true,
  running: true,
  cpuPercent: 12.5,
  cpuUtilizationPercent: 12.5,
  memoryUsageBytes: null,
  memoryLimitBytes: 1_000,
  memoryUtilizationPercent: null,
  playersOnline: 2,
  networkRxBytesPerSecond: 4,
  networkTxBytesPerSecond: 5
};

const clusters: MarkerCluster[] = [{
  id: "cluster",
  occurredAt: 10_000,
  tone: "join",
  slot: 2,
  slotCount: 24,
  markers: [{ id: "event", occurredAt: 10_000, label: "<Alex> joined & played", tone: "join" }]
}];

describe("server timeline chart windows", () => {
  it("places now at the right edge of a live viewport and buffers one span behind it", () => {
    const viewport = liveTimelineWindow(1_000, 10_000);
    expect(viewport).toEqual({ from: 9_000, to: 10_000 });
    expect(timelineQueryWindow(viewport, true)).toEqual({ from: 8_000, to: 10_000 });
  });

  it("buffers historical viewports on both sides and caps full-day queries", () => {
    expect(timelineQueryWindow({ from: 10_000, to: 20_000 }, false)).toEqual({ from: 5_000, to: 25_000 });
    const fullDay = { from: 0, to: timelineRetentionMs };
    expect(timelineQueryWindow(fullDay, true)).toEqual(fullDay);
  });

  it("converts absolute and percentage data-zoom events into viewports", () => {
    expect(dataZoomWindow({ startValue: 2_000, endValue: 4_000 }, { from: 0, to: 10_000 })).toEqual({ from: 2_000, to: 4_000 });
    expect(dataZoomWindow({ batch: [{ start: 25, end: 75 }] }, { from: 0, to: 20_000 })).toEqual({ from: 5_000, to: 15_000 });
  });

  it("requests a new buffer only near a loaded edge", () => {
    expect(timelineNeedsRefill({ from: 2_000, to: 8_000 }, { from: 0, to: 10_000 })).toBe(false);
    expect(timelineNeedsRefill({ from: 500, to: 6_500 }, { from: 0, to: 10_000 })).toBe(true);
  });
});

describe("server timeline ECharts option", () => {
  it("assigns distinct axes, retains nulls as gaps, and configures modified-wheel zoom", () => {
    const option = buildTimelineChartOption({
      samples: [sample],
      query: { from: 0, to: 20_000 },
      viewport: { from: 5_000, to: 15_000 },
      enabled,
      clusters,
      palette: defaultTimelinePalette,
      formatTime: String,
      formatShortTime: (value) => `short:${value}`,
      now: 12_000
    }) as {
      animation: boolean;
      yAxis: unknown[];
      dataZoom: Array<{ startValue: number; endValue: number; zoomOnMouseWheel: string }>;
      xAxis: { axisLabel: { formatter: (value: number) => string } };
      series: Array<{ id: string; yAxisId: string; data: Array<[number, number | string]>; symbol?: string; silent?: boolean; smooth?: number; smoothMonotone?: string; connectNulls?: boolean; lineStyle?: { type?: string }; emphasis?: { disabled: boolean }; markLine?: { data: Array<{ lineStyle: { type: string; width: number } }> } }>;
    };
    expect(option.animation).toBe(false);
    expect(option).not.toHaveProperty("tooltip");
    expect(option.yAxis).toHaveLength(3);
    expect(option.dataZoom[0]).toMatchObject({ startValue: 5_000, endValue: 15_000, zoomOnMouseWheel: "ctrl" });
    expect(option.series.find((series) => series.id === "memoryUtilizationPercent")?.data).toEqual([[10_000, "-"]]);
    expect(option.series.find((series) => series.id === "memoryUtilizationPercent")?.yAxisId).toBe("timeline-memory-axis");
    expect(option.series.find((series) => series.id === "cpuUtilizationPercent")?.connectNulls).toBe(false);
    expect(option.series.find((series) => series.id === "cpuUtilizationPercent")).toMatchObject({ symbol: "none", silent: true, smooth: 0.24, smoothMonotone: "x" });
    expect(option.series.find((series) => series.id === "cpuUtilizationPercent")?.emphasis).toEqual({ disabled: true });
    expect(option.series.find((series) => series.id === "memoryUtilizationPercent")?.lineStyle?.type).toBe("solid");
    expect(option.series.find((series) => series.id === "timeline-annotations")?.markLine?.data).toHaveLength(1);
    expect(option.series.find((series) => series.id === "timeline-annotations")?.markLine?.data[0].lineStyle.type).toBe("dashed");
    expect(option.xAxis.axisLabel.formatter(10_000)).toBe("10000");
  });

  it("omits disabled metric series", () => {
    const option = buildTimelineChartOption({
      samples: [sample],
      query: { from: 0, to: 20_000 },
      viewport: { from: 5_000, to: 15_000 },
      enabled: { ...enabled, cpuUtilizationPercent: false },
      clusters: [],
      palette: defaultTimelinePalette,
      formatTime: String,
      formatShortTime: String,
      now: 30_000
    }) as { yAxis: unknown[]; series: Array<{ id: string }> };
    expect(option.series.some((series) => series.id === "cpuUtilizationPercent")).toBe(false);
    expect(option.yAxis).toHaveLength(2);
  });

  it("removes unused right axes and gives players an integer step axis only when enabled", () => {
    const option = buildTimelineChartOption({
      samples: [sample],
      query: { from: 0, to: 20_000 },
      viewport: { from: 5_000, to: 15_000 },
      enabled: { ...enabled, networkRxBytesPerSecond: false, networkTxBytesPerSecond: false, playersOnline: true },
      clusters: [],
      palette: defaultTimelinePalette,
      formatTime: String,
      formatShortTime: String,
      now: 30_000
    }) as { yAxis: Array<{ name?: string }>; series: Array<{ id: string; step?: string }> };
    expect(option.yAxis.map((axis) => axis.name)).toEqual(["CPU", "Memory %", "Players"]);
    expect(option.series.find((series) => series.id === "playersOnline")?.step).toBe("end");
  });

  it("uses a clearly bounded adaptive memory axis for the loaded sample buffer", () => {
    const stableMemory = [
      { ...sample, sampledAt: 10_000, memoryUtilizationPercent: 66.1 },
      { ...sample, sampledAt: 20_000, memoryUtilizationPercent: 66.8 },
      { ...sample, sampledAt: 30_000, memoryUtilizationPercent: 67.2 }
    ];
    const bounds = adaptiveMemoryAxisBounds(stableMemory);
    expect(bounds.max - bounds.min).toBeGreaterThanOrEqual(5);
    expect(bounds.min).toBeGreaterThan(60);
    expect(bounds.max).toBeLessThan(70);
  });

  it("keeps every loaded memory value inside one stable pan domain", () => {
    const crossingMemory = [
      { ...sample, sampledAt: 0, memoryUtilizationPercent: 20 },
      { ...sample, sampledAt: 10_000, memoryUtilizationPercent: 60 },
      { ...sample, sampledAt: 20_000, memoryUtilizationPercent: 65 },
      { ...sample, sampledAt: 30_000, memoryUtilizationPercent: 5 }
    ];
    const bounds = adaptiveMemoryAxisBounds(crossingMemory);
    expect(bounds.min).toBeLessThan(35);
    expect(bounds.max).toBeGreaterThan(65);
  });

  it("keeps true percentage endpoints above the rendered chart boundary", () => {
    const bounds = adaptiveMemoryAxisBounds([
      { ...sample, sampledAt: 10_000, memoryUtilizationPercent: 0 },
      { ...sample, sampledAt: 20_000, memoryUtilizationPercent: 100 }
    ]);
    expect(bounds).toEqual({ min: -0.5, max: 100.5 });
  });

  it("omits seconds from axis labels for one-hour and longer viewports", () => {
    const option = buildTimelineChartOption({
      samples: [sample],
      query: { from: 0, to: 4_000_000 },
      viewport: { from: 0, to: 3_600_000 },
      enabled,
      clusters: [],
      palette: defaultTimelinePalette,
      formatTime: (value) => `seconds:${value}`,
      formatShortTime: (value) => `minutes:${value}`,
      now: 5_000_000
    }) as { xAxis: { axisLabel: { formatter: (value: number) => string } } };
    expect(option.xAxis.axisLabel.formatter(10_000)).toBe("minutes:10000");
  });

  it("escapes event text rendered into the HTML tooltip", () => {
    const html = timelineTooltipHtml([{ axisValue: 10_000, seriesId: "cpuUtilizationPercent", seriesName: "CPU", value: [10_000, 12.5] }], clusters, 10_000, String);
    expect(html).toContain("&lt;Alex&gt; joined &amp; played");
    expect(html).not.toContain("<Alex>");
    expect(escapeTimelineHtml('"server"')).toBe("&quot;server&quot;");
  });

  it("builds the hover tooltip without asking ECharts to highlight or redraw a series", () => {
    const laterSample = { ...sample, sampledAt: 20_000, cpuUtilizationPercent: 30 };
    expect(nearestTimelineSample([sample, laterSample], 18_000)).toBe(laterSample);
    const html = timelineHoverTooltipHtml(18_000, [sample, laterSample], { ...enabled, memoryUtilizationPercent: false }, [], 10_000, String);
    expect(html).toContain("20000");
    expect(html).toContain("CPU: 30.0%");
    expect(html).toContain("Players: 2 online");
    expect(html).not.toContain("Memory:");
  });
});
