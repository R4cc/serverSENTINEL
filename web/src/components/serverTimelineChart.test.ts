import { describe, expect, it } from "vitest";
import type { ServerTimelineResourcePoint } from "../types";
import type { MarkerCluster, SeriesKey } from "./ServerTimeline";
import {
  buildTimelineChartOption,
  memoryAxisMaximum,
  dataZoomWindow,
  defaultTimelinePalette,
  escapeTimelineHtml,
  liveTimelineWindow,
  liveTimelineFutureRatio,
  nearestTimelineSample,
  timelineHoverTooltipHtml,
  timelineNeedsRefill,
  timelineQueryWindow,
  timelineRetentionMs,
  timelineMetricBandGrid,
  timelineTooltipHtml
} from "./serverTimelineChart";

const enabled: Record<SeriesKey, boolean> = {
  cpuUtilizationPercent: true,
  memoryUsageBytes: true,
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
  memoryUsageBytes: 768,
  memoryLimitBytes: 1_000,
  memoryUtilizationPercent: null,
  playersOnline: 2,
  networkRxBytesPerSecond: 4,
  networkTxBytesPerSecond: 5
};

const clusters: MarkerCluster[] = [{
  id: "cluster",
  occurredAt: 10_000,
  tone: "server",
  slot: 2,
  slotCount: 24,
  markers: [{ id: "event", occurredAt: 10_000, label: "<Server> started & recovered", tone: "server" }]
}];

describe("server timeline chart windows", () => {
  it("reserves future headroom for planned schedules and buffers one span behind a live viewport", () => {
    const viewport = liveTimelineWindow(1_000, 10_000);
    expect(liveTimelineFutureRatio).toBe(0.1);
    expect(viewport).toEqual({ from: 9_100, to: 10_100 });
    expect(timelineQueryWindow(viewport, true)).toEqual({ from: 8_100, to: 10_100 });
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
    expect(option.series.find((series) => series.id === "memoryUsageBytes")?.data).toEqual([[10_000, 768]]);
    expect(option.series.find((series) => series.id === "memoryUsageBytes")?.yAxisId).toBe("timeline-memory-axis");
    expect(option.series.find((series) => series.id === "cpuUtilizationPercent")?.connectNulls).toBe(false);
    expect(option.series.find((series) => series.id === "cpuUtilizationPercent")).toMatchObject({ symbol: "none", silent: true, smooth: 0.24, smoothMonotone: "x" });
    expect(option.series.find((series) => series.id === "cpuUtilizationPercent")?.emphasis).toEqual({ disabled: true });
    expect(option.series.find((series) => series.id === "memoryUsageBytes")?.lineStyle?.type).toBe("solid");
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

  it("builds separate metric bands with an identical shared plot grid", () => {
    const cpu = buildTimelineChartOption({
      samples: [sample],
      query: { from: 0, to: 20_000 },
      viewport: { from: 5_000, to: 15_000 },
      enabled,
      clusters: [],
      palette: defaultTimelinePalette,
      formatTime: String,
      formatShortTime: String,
      now: 12_000,
      gridOverride: timelineMetricBandGrid,
      seriesKeys: ["cpuUtilizationPercent"]
    }) as { grid: { left: number; right: number }; yAxis: Array<{ position: string }>; series: Array<{ id: string }> };
    const memory = buildTimelineChartOption({
      samples: [sample],
      query: { from: 0, to: 20_000 },
      viewport: { from: 5_000, to: 15_000 },
      enabled,
      clusters: [],
      palette: defaultTimelinePalette,
      formatTime: String,
      formatShortTime: String,
      now: 12_000,
      gridOverride: timelineMetricBandGrid,
      seriesKeys: ["memoryUsageBytes"]
    }) as { grid: { left: number; right: number }; yAxis: Array<{ position: string }>; series: Array<{ id: string }> };
    expect(cpu.grid).toMatchObject(timelineMetricBandGrid);
    expect(memory.grid).toMatchObject(timelineMetricBandGrid);
    expect(cpu.yAxis).toHaveLength(1);
    expect(memory.yAxis).toHaveLength(1);
    expect(cpu.yAxis[0].position).toBe("left");
    expect(memory.yAxis[0].position).toBe("left");
    expect(cpu.series.some((series) => series.id === "memoryUsageBytes")).toBe(false);
    expect(memory.series.some((series) => series.id === "cpuUtilizationPercent")).toBe(false);
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
    expect(option.yAxis.map((axis) => axis.name)).toEqual(["CPU", "Memory", "Players"]);
    expect(option.series.find((series) => series.id === "playersOnline")?.step).toBe("end");
  });

  it("uses the configured memory limit as a normal zero-based chart maximum", () => {
    const samples = [
      { ...sample, sampledAt: 10_000, memoryUsageBytes: 600, memoryLimitBytes: 1_024 },
      { ...sample, sampledAt: 20_000, memoryUsageBytes: 700, memoryLimitBytes: 1_024 }
    ];
    expect(memoryAxisMaximum(samples)).toBe(1_024);
  });

  it("keeps plotting memory usage when the Docker memory limit is unavailable", () => {
    const withoutLimit = [
      { ...sample, sampledAt: 10_000, memoryUsageBytes: 700, memoryLimitBytes: null, memoryUtilizationPercent: null },
      { ...sample, sampledAt: 20_000, memoryUsageBytes: 800, memoryLimitBytes: null, memoryUtilizationPercent: null }
    ];
    const option = buildTimelineChartOption({
      samples: withoutLimit,
      query: { from: 0, to: 30_000 },
      viewport: { from: 0, to: 30_000 },
      enabled,
      clusters: [],
      palette: defaultTimelinePalette,
      formatTime: String,
      formatShortTime: String,
      now: 40_000,
      gridOverride: timelineMetricBandGrid,
      seriesKeys: ["memoryUsageBytes"]
    }) as { yAxis: Array<{ min: number; max: number }>; series: Array<{ id: string; data: Array<[number, number]> }> };
    expect(option.yAxis[0].min).toBe(0);
    expect(option.yAxis[0].max).toBeGreaterThan(800);
    expect(option.series.find((series) => series.id === "memoryUsageBytes")?.data).toEqual([[10_000, 700], [20_000, 800]]);
  });

  it("adds headroom when usage exceeds the reported memory limit", () => {
    expect(memoryAxisMaximum([{ ...sample, memoryUsageBytes: 1_200, memoryLimitBytes: 1_000 }])).toBeGreaterThan(1_200);
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
    expect(html).toContain("&lt;Server&gt; started &amp; recovered");
    expect(html).not.toContain("<Server>");
    expect(escapeTimelineHtml('"server"')).toBe("&quot;server&quot;");
  });

  it("builds the hover tooltip without asking ECharts to highlight or redraw a series", () => {
    const laterSample = { ...sample, sampledAt: 20_000, cpuUtilizationPercent: 30 };
    expect(nearestTimelineSample([sample, laterSample], 18_000)).toBe(laterSample);
    const html = timelineHoverTooltipHtml(18_000, [sample, laterSample], { ...enabled, memoryUsageBytes: false }, [], 10_000, String);
    expect(html).toContain("20000");
    expect(html).toContain("CPU: 30.0%");
    expect(html).toContain("Players: 2 online");
    expect(html).not.toContain("Memory:");
  });

  it("formats the memory hover row as usage with an optional capacity detail", () => {
    const html = timelineHoverTooltipHtml(10_000, [sample], enabled, [], 10_000, String);
    expect(html).toContain("Memory: 768 B");
    expect(html).toContain("Limit 1000 B");
    expect(html).not.toContain("Memory: 0.0%");
  });
});
