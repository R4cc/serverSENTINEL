import { describe, expect, it } from "vitest";
import type { ServerTimelineResourcePoint } from "../types";
import type { MarkerCluster, SeriesKey } from "./ServerTimeline";
import {
  buildTimelineChartOption,
  dataZoomWindow,
  defaultTimelinePalette,
  escapeTimelineHtml,
  liveTimelineWindow,
  timelineNeedsRefill,
  timelineQueryWindow,
  timelineRetentionMs,
  timelineTooltipHtml
} from "./serverTimelineChart";

const enabled: Record<SeriesKey, boolean> = {
  cpuPercent: true,
  memoryUsageBytes: true,
  networkRxBytesPerSecond: true,
  networkTxBytesPerSecond: true
};

const sample: ServerTimelineResourcePoint = {
  sampledAt: 10_000,
  available: true,
  running: true,
  cpuPercent: 12.5,
  memoryUsageBytes: null,
  memoryLimitBytes: 1_000,
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
  it("reserves future space in a live viewport and buffers one span behind it", () => {
    const viewport = liveTimelineWindow(1_000, 10_000);
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
  it("assigns three axes, retains nulls as gaps, and configures modified-wheel zoom", () => {
    const option = buildTimelineChartOption({
      samples: [sample],
      query: { from: 0, to: 20_000 },
      viewport: { from: 5_000, to: 15_000 },
      enabled,
      clusters,
      palette: defaultTimelinePalette,
      formatTime: String,
      formatDate: String,
      reducedMotion: true,
      now: 12_000
    }) as {
      animation: boolean;
      yAxis: unknown[];
      dataZoom: Array<{ startValue: number; endValue: number; zoomOnMouseWheel: string }>;
      series: Array<{ id: string; yAxisIndex: number; data: Array<[number, number | string]>; smooth?: number; smoothMonotone?: string; connectNulls?: boolean; markLine?: { data: Array<{ lineStyle: { width: number } }> } }>;
    };
    expect(option.animation).toBe(false);
    expect(option.yAxis).toHaveLength(3);
    expect(option.dataZoom[0]).toMatchObject({ startValue: 5_000, endValue: 15_000, zoomOnMouseWheel: "ctrl" });
    expect(option.series.find((series) => series.id === "memoryUsageBytes")?.data).toEqual([[10_000, "-"]]);
    expect(option.series.find((series) => series.id === "cpuPercent")?.connectNulls).toBe(false);
    expect(option.series.find((series) => series.id === "cpuPercent")).toMatchObject({ smooth: 0.28, smoothMonotone: "x" });
    expect(option.series.find((series) => series.id === "timeline-annotations")?.markLine?.data).toHaveLength(2);
    expect(option.series.find((series) => series.id === "timeline-annotations")?.markLine?.data[0].lineStyle.width).toBe(2.5);
  });

  it("omits disabled metric series", () => {
    const option = buildTimelineChartOption({
      samples: [sample],
      query: { from: 0, to: 20_000 },
      viewport: { from: 5_000, to: 15_000 },
      enabled: { ...enabled, cpuPercent: false },
      clusters: [],
      palette: defaultTimelinePalette,
      formatTime: String,
      formatDate: String,
      reducedMotion: false,
      now: 30_000
    }) as { series: Array<{ id: string }> };
    expect(option.series.some((series) => series.id === "cpuPercent")).toBe(false);
  });

  it("escapes event text rendered into the HTML tooltip", () => {
    const html = timelineTooltipHtml([{ axisValue: 10_000, seriesId: "cpuPercent", seriesName: "CPU", value: [10_000, 12.5] }], clusters, 10_000, String);
    expect(html).toContain("&lt;Alex&gt; joined &amp; played");
    expect(html).not.toContain("<Alex>");
    expect(escapeTimelineHtml('"server"')).toBe("&quot;server&quot;");
  });
});
