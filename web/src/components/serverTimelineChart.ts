import type { EChartsCoreOption } from "echarts/core";
import type { ServerTimelineResourcePoint } from "../types";
import type { MarkerCluster, SeriesKey, TimelineWindow } from "./ServerTimeline";

export const timelineRetentionMs = 24 * 60 * 60 * 1000;
export const timelineChartGrid = { left: 60, right: 154, top: 48, bottom: 42 } as const;

export type TimelinePalette = {
  cpu: string;
  memory: string;
  networkIn: string;
  networkOut: string;
  join: string;
  leave: string;
  server: string;
  schedule: string;
  accent: string;
  text: string;
  textMuted: string;
  border: string;
  surface: string;
};

export const defaultTimelinePalette: TimelinePalette = {
  cpu: "#4169ff",
  memory: "#8b4cf6",
  networkIn: "#34a853",
  networkOut: "#159ca6",
  join: "#2fa84f",
  leave: "#df3d72",
  server: "#f28b16",
  schedule: "#7a42e8",
  accent: "#4169ff",
  text: "#1f2530",
  textMuted: "#697386",
  border: "#d9dee8",
  surface: "#ffffff"
};

export function liveTimelineWindow(span: number, now = Date.now()): TimelineWindow {
  const to = now + span * 0.1;
  return { from: to - span, to };
}

export function timelineQueryWindow(viewport: TimelineWindow, live: boolean): TimelineWindow {
  const span = Math.max(1, viewport.to - viewport.from);
  if (span >= timelineRetentionMs) return { ...viewport };
  const desired = live
    ? { from: viewport.from - span, to: viewport.to }
    : { from: viewport.from - span * 0.5, to: viewport.to + span * 0.5 };
  if (desired.to - desired.from <= timelineRetentionMs) return desired;
  const center = (viewport.from + viewport.to) / 2;
  return { from: center - timelineRetentionMs / 2, to: center + timelineRetentionMs / 2 };
}

export function timelineNeedsRefill(viewport: TimelineWindow, query: TimelineWindow) {
  const span = Math.max(1, viewport.to - viewport.from);
  const next = timelineQueryWindow(viewport, false);
  const queryAlreadyMatches = Math.abs(next.from - query.from) < 1_000 && Math.abs(next.to - query.to) < 1_000;
  if (queryAlreadyMatches) return false;
  return viewport.from - query.from <= span * 0.25 || query.to - viewport.to <= span * 0.25;
}

export function dataZoomWindow(
  event: { start?: number; end?: number; startValue?: number; endValue?: number; batch?: Array<{ start?: number; end?: number; startValue?: number; endValue?: number }> },
  query: TimelineWindow
): TimelineWindow | null {
  const zoom = event.batch?.[0] ?? event;
  const startValue = Number(zoom.startValue);
  const endValue = Number(zoom.endValue);
  if (Number.isFinite(startValue) && Number.isFinite(endValue) && endValue > startValue) {
    return { from: startValue, to: endValue };
  }
  const start = Number(zoom.start);
  const end = Number(zoom.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  const querySpan = query.to - query.from;
  return {
    from: query.from + querySpan * start / 100,
    to: query.from + querySpan * end / 100
  };
}

export function escapeTimelineHtml(value: unknown) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatBytes(value: number) {
  if (value < 1024) return `${Math.max(0, value).toFixed(0)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(0)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatMetric(key: SeriesKey, value: number) {
  if (key === "cpuPercent") return `${value.toFixed(1)}%`;
  if (key === "memoryUsageBytes") return formatBytes(value);
  return `${formatBytes(value)}/s`;
}

type TooltipEntry = {
  axisValue?: unknown;
  seriesId?: unknown;
  seriesName?: unknown;
  value?: unknown;
  color?: unknown;
};

export function timelineTooltipHtml(
  rawEntries: unknown,
  clusters: MarkerCluster[],
  span: number,
  formatDate: (value: string | number | Date) => string
) {
  const entries = (Array.isArray(rawEntries) ? rawEntries : [rawEntries]) as TooltipEntry[];
  const timestamp = Number(entries[0]?.axisValue ?? (Array.isArray(entries[0]?.value) ? entries[0].value[0] : NaN));
  if (!Number.isFinite(timestamp)) return "";
  const rows = entries.flatMap((entry) => {
    const key = String(entry.seriesId ?? "") as SeriesKey;
    if (!(["cpuPercent", "memoryUsageBytes", "networkRxBytesPerSecond", "networkTxBytesPerSecond"] as string[]).includes(key)) return [];
    const pair = Array.isArray(entry.value) ? entry.value : [];
    const value = Number(pair[1]);
    if (!Number.isFinite(value)) return [];
    return [`<span><i class="timelineTooltipSwatch series-${escapeTimelineHtml(key)}"></i>${escapeTimelineHtml(entry.seriesName)}: ${escapeTimelineHtml(formatMetric(key, value))}</span>`];
  });
  const nearby = clusters
    .filter((cluster) => Math.abs(cluster.occurredAt - timestamp) <= span / 80)
    .flatMap((cluster) => cluster.markers)
    .map((marker) => `<span class="timelineTooltipEvent">${escapeTimelineHtml(marker.label)}</span>`);
  return `<div class="serverTimelineTooltip"><strong>${escapeTimelineHtml(formatDate(timestamp))}</strong>${rows.join("")}${nearby.join("")}</div>`;
}

function markerColor(cluster: MarkerCluster, palette: TimelinePalette) {
  return palette[cluster.tone];
}

export function buildTimelineChartOption({
  samples,
  query,
  viewport,
  enabled,
  clusters,
  palette,
  formatTime,
  formatDate,
  reducedMotion,
  now
}: {
  samples: ServerTimelineResourcePoint[];
  query: TimelineWindow;
  viewport: TimelineWindow;
  enabled: Record<SeriesKey, boolean>;
  clusters: MarkerCluster[];
  palette: TimelinePalette;
  formatTime: (value: string | number | Date) => string;
  formatDate: (value: string | number | Date) => string;
  reducedMotion: boolean;
  now: number;
}): EChartsCoreOption {
  const metricSeries: Array<{ key: SeriesKey; name: string; yAxisIndex: number; color: string; width: number }> = [
    { key: "cpuPercent", name: "CPU", yAxisIndex: 0, color: palette.cpu, width: 2 },
    { key: "memoryUsageBytes", name: "Memory", yAxisIndex: 1, color: palette.memory, width: 2 },
    { key: "networkRxBytesPerSecond", name: "Network In", yAxisIndex: 2, color: palette.networkIn, width: 1.8 },
    { key: "networkTxBytesPerSecond", name: "Network Out", yAxisIndex: 2, color: palette.networkOut, width: 1.8 }
  ];
  const markerLines: Array<{
    xAxis: number;
    lineStyle: { color: string; type: "dashed"; width: number };
    label: { show: boolean; formatter?: string; color?: string; position?: string };
  }> = clusters.map((cluster) => ({
    xAxis: cluster.occurredAt,
    lineStyle: { color: markerColor(cluster, palette), type: "dashed" as const, width: 1 },
    label: { show: false }
  }));
  if (now >= viewport.from && now <= viewport.to) {
    markerLines.push({
      xAxis: now,
      lineStyle: { color: palette.accent, type: "dashed", width: 1 },
      label: { show: true, formatter: "Now", color: palette.textMuted, position: "insideEndTop" }
    });
  }

  return {
    animation: !reducedMotion,
    aria: {
      enabled: true,
      description: `Server resource timeline with ${samples.length} samples and ${clusters.reduce((total, cluster) => total + cluster.markers.length, 0)} annotations.`
    },
    grid: { ...timelineChartGrid, containLabel: false },
    tooltip: {
      trigger: "axis",
      renderMode: "html",
      appendToBody: true,
      confine: true,
      className: "serverTimelineTooltipHost",
      axisPointer: { type: "line", lineStyle: { color: palette.textMuted, type: "dashed" } },
      formatter: (entries: unknown) => timelineTooltipHtml(entries, clusters, viewport.to - viewport.from, formatDate)
    },
    xAxis: {
      type: "time",
      min: query.from,
      max: query.to,
      axisLine: { lineStyle: { color: palette.border } },
      axisTick: { show: false },
      axisLabel: { color: palette.textMuted, hideOverlap: true, formatter: (value: number) => formatTime(value) },
      splitLine: { show: false }
    },
    yAxis: [
      {
        type: "value",
        position: "left",
        min: 0,
        axisLine: { show: true, lineStyle: { color: palette.border } },
        axisTick: { show: false },
        axisLabel: { color: palette.textMuted, formatter: (value: number) => `${value.toFixed(0)}%` },
        splitLine: { lineStyle: { color: palette.border, type: "dashed" } }
      },
      {
        type: "value",
        position: "right",
        min: 0,
        axisLine: { show: true, lineStyle: { color: palette.border } },
        axisTick: { show: false },
        axisLabel: { color: palette.textMuted, formatter: (value: number) => formatBytes(value) },
        splitLine: { show: false }
      },
      {
        type: "value",
        position: "right",
        offset: 76,
        min: 0,
        axisLine: { show: true, lineStyle: { color: palette.border } },
        axisTick: { show: false },
        axisLabel: { color: palette.textMuted, formatter: (value: number) => `${formatBytes(value)}/s` },
        splitLine: { show: false }
      }
    ],
    dataZoom: [{
      id: "timeline-inside",
      type: "inside",
      xAxisIndex: 0,
      startValue: viewport.from,
      endValue: viewport.to,
      filterMode: "none",
      zoomOnMouseWheel: "ctrl",
      moveOnMouseMove: true,
      moveOnMouseWheel: false,
      preventDefaultMouseMove: true
    }],
    series: [
      ...metricSeries.filter((series) => enabled[series.key]).map((series) => ({
        id: series.key,
        name: series.name,
        type: "line" as const,
        yAxisIndex: series.yAxisIndex,
        data: samples.map((sample) => [sample.sampledAt, sample[series.key] ?? "-"]),
        showSymbol: false,
        connectNulls: false,
        silent: false,
        lineStyle: { color: series.color, width: series.width },
        itemStyle: { color: series.color },
        emphasis: { focus: "series" as const },
        animation: !reducedMotion
      })),
      {
        id: "timeline-annotations",
        name: "Timeline annotations",
        type: "line",
        yAxisIndex: 0,
        data: [[query.from, 0], [query.to, 0]],
        showSymbol: false,
        silent: true,
        tooltip: { show: false },
        lineStyle: { opacity: 0 },
        markLine: {
          silent: true,
          symbol: ["none", "none"],
          animation: false,
          data: markerLines
        }
      }
    ]
  };
}
