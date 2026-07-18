import type { EChartsCoreOption } from "echarts/core";
import type { ServerTimelineResourcePoint } from "../types";
import type { MarkerCluster, SeriesKey, TimelineWindow } from "./ServerTimeline";

export const timelineRetentionMs = 24 * 60 * 60 * 1000;
export const timelineChartGrid = { left: 56, right: 24, top: 66, bottom: 38 } as const;

export function timelineChartGridForEnabled(enabled: Record<SeriesKey, boolean>, top: number = timelineChartGrid.top) {
  const cpu = enabled.cpuUtilizationPercent;
  const memory = enabled.memoryUtilizationPercent;
  const network = enabled.networkRxBytesPerSecond || enabled.networkTxBytesPerSecond;
  const players = enabled.playersOnline;
  const visibleRightAxes = Number(memory) + Number(network) + Number(players);
  return {
    ...timelineChartGrid,
    top,
    left: cpu ? 56 : 24,
    right: visibleRightAxes === 3 ? 180 : visibleRightAxes === 2 ? 128 : visibleRightAxes === 1 ? 76 : 24
  };
}

export function adaptiveMemoryAxisBounds(samples: ServerTimelineResourcePoint[]) {
  const values = samples.flatMap((sample) => (
    typeof sample.memoryUtilizationPercent === "number"
    && Number.isFinite(sample.memoryUtilizationPercent)
      ? [sample.memoryUtilizationPercent]
      : []
  ));
  if (!values.length) return { min: 0, max: 100 };
  const observedMin = Math.min(...values);
  const observedMax = Math.max(...values);
  const observedSpan = observedMax - observedMin;
  const span = Math.max(5, observedSpan * 1.5);
  const center = (observedMin + observedMax) / 2;
  let min = Math.max(0, center - span / 2);
  let max = Math.min(100, center + span / 2);
  if (max - min < span) {
    if (min === 0) max = Math.min(100, span);
    else min = Math.max(0, 100 - span);
  }
  if (observedMin <= 0) min = -0.5;
  if (observedMax >= 100) max = 100.5;
  return { min: Math.floor(min * 10) / 10, max: Math.ceil(max * 10) / 10 };
}

export type TimelinePalette = {
  cpu: string;
  memory: string;
  networkIn: string;
  networkOut: string;
  players: string;
  join: string;
  leave: string;
  server: string;
  automation: string;
  planned: string;
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
  players: "#667085",
  join: "#2fa84f",
  leave: "#df3d72",
  server: "#f28b16",
  automation: "#7a42e8",
  planned: "#7a42e8",
  accent: "#4169ff",
  text: "#1f2530",
  textMuted: "#697386",
  border: "#d9dee8",
  surface: "#ffffff"
};

export function liveTimelineWindow(span: number, now = Date.now()): TimelineWindow {
  return { from: now - span, to: now };
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
  if (key === "cpuUtilizationPercent" || key === "memoryUtilizationPercent") return `${value.toFixed(1)}%`;
  if (key === "playersOnline") return `${Math.round(value)} online`;
  return `${formatBytes(value)}/s`;
}

type TooltipEntry = {
  axisValue?: unknown;
  seriesId?: unknown;
  seriesName?: unknown;
  value?: unknown;
  color?: unknown;
  detail?: string;
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
    if (!(["cpuUtilizationPercent", "memoryUtilizationPercent", "networkRxBytesPerSecond", "networkTxBytesPerSecond", "playersOnline"] as string[]).includes(key)) return [];
    const pair = Array.isArray(entry.value) ? entry.value : [];
    const value = Number(pair[1]);
    if (!Number.isFinite(value)) return [];
    const detail = entry.detail ? ` <small>${escapeTimelineHtml(entry.detail)}</small>` : "";
    return [`<span><i class="timelineTooltipSwatch series-${escapeTimelineHtml(key)}"></i>${escapeTimelineHtml(entry.seriesName)}: ${escapeTimelineHtml(formatMetric(key, value))}${detail}</span>`];
  });
  const nearby = clusters
    .filter((cluster) => Math.abs(cluster.occurredAt - timestamp) <= span / 80)
    .flatMap((cluster) => cluster.markers)
    .map((marker) => `<span class="timelineTooltipEvent">${escapeTimelineHtml(marker.label)}</span>`);
  return `<div class="serverTimelineTooltip"><strong>${escapeTimelineHtml(formatDate(timestamp))}</strong>${rows.join("")}${nearby.join("")}</div>`;
}

export function nearestTimelineSample(samples: ServerTimelineResourcePoint[], timestamp: number) {
  if (!samples.length) return undefined;
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].sampledAt < timestamp) low = middle + 1;
    else high = middle;
  }
  const after = samples[low];
  const before = samples[Math.max(0, low - 1)];
  return Math.abs(before.sampledAt - timestamp) <= Math.abs(after.sampledAt - timestamp) ? before : after;
}

export function timelineHoverTooltipHtml(
  timestamp: number,
  samples: ServerTimelineResourcePoint[],
  enabled: Record<SeriesKey, boolean>,
  clusters: MarkerCluster[],
  span: number,
  formatDate: (value: string | number | Date) => string
) {
  const sample = nearestTimelineSample(samples, timestamp);
  const tooltipTimestamp = sample?.sampledAt ?? timestamp;
  const names: Record<SeriesKey, string> = {
    cpuUtilizationPercent: "CPU",
    memoryUtilizationPercent: "Memory",
    networkRxBytesPerSecond: "Network In",
    networkTxBytesPerSecond: "Network Out",
    playersOnline: "Players"
  };
  const entries: TooltipEntry[] = (Object.keys(names) as SeriesKey[]).flatMap((key) => {
    const value = sample?.[key];
    if ((key !== "playersOnline" && !enabled[key]) || typeof value !== "number" || !Number.isFinite(value)) return [];
    const detail = key === "memoryUtilizationPercent" && typeof sample?.memoryUsageBytes === "number" && typeof sample?.memoryLimitBytes === "number"
      ? `${formatBytes(sample.memoryUsageBytes)} / ${formatBytes(sample.memoryLimitBytes)}`
      : undefined;
    return [{ axisValue: tooltipTimestamp, seriesId: key, seriesName: names[key], value: [tooltipTimestamp, value], detail }];
  });
  return timelineTooltipHtml(entries.length ? entries : [{ axisValue: tooltipTimestamp }], clusters, span, formatDate);
}

export function buildTimelineChartOption({
  samples,
  query,
  viewport,
  enabled,
  clusters,
  palette,
  formatTime,
  formatShortTime,
  now,
  gridTop
}: {
  samples: ServerTimelineResourcePoint[];
  query: TimelineWindow;
  viewport: TimelineWindow;
  enabled: Record<SeriesKey, boolean>;
  clusters: MarkerCluster[];
  palette: TimelinePalette;
  formatTime: (value: string | number | Date) => string;
  formatShortTime: (value: string | number | Date) => string;
  now: number;
  gridTop?: number;
}): EChartsCoreOption {
  const grid = timelineChartGridForEnabled(enabled, gridTop);
  const cpuEnabled = enabled.cpuUtilizationPercent;
  const memoryEnabled = enabled.memoryUtilizationPercent;
  const networkEnabled = enabled.networkRxBytesPerSecond || enabled.networkTxBytesPerSecond;
  const playersEnabled = enabled.playersOnline;
  const yAxis: Array<Record<string, unknown>> = [];
  let cpuAxis = "";
  let memoryAxis = "";
  let networkAxis = "";
  let playersAxis = "";
  let rightAxisOffset = 0;
  if (cpuEnabled) {
    cpuAxis = "timeline-cpu-axis";
    yAxis.push({
      id: cpuAxis,
      type: "value",
      position: "left",
      min: 0,
      max: 100,
      name: "CPU",
      nameTextStyle: { color: palette.textMuted, fontSize: 10, padding: [0, 0, 4, 0] },
      axisLine: { show: true, lineStyle: { color: palette.border } },
      axisTick: { show: false },
      axisLabel: { color: palette.textMuted, formatter: (value: number) => `${value.toFixed(0)}%` },
      splitLine: { lineStyle: { color: palette.border, type: "dashed", opacity: 0.7 } }
    });
  }
  if (memoryEnabled) {
    memoryAxis = "timeline-memory-axis";
    const bounds = adaptiveMemoryAxisBounds(samples);
    yAxis.push({
      id: memoryAxis,
      type: "value",
      position: "right",
      offset: rightAxisOffset,
      min: bounds.min,
      max: bounds.max,
      name: "Memory %",
      nameTextStyle: { color: palette.memory, fontSize: 10, padding: [0, 0, 4, 0] },
      axisLine: { show: true, lineStyle: { color: palette.memory, opacity: 0.6 } },
      axisTick: { show: false },
      axisLabel: { color: palette.textMuted, formatter: (value: number) => value < 0 || value > 100 ? "" : `${value.toFixed(1)}%` },
      splitLine: { show: false }
    });
    rightAxisOffset += 52;
  }
  if (playersEnabled) {
    playersAxis = "timeline-players-axis";
    yAxis.push({
      id: playersAxis,
      type: "value",
      position: "right",
      offset: rightAxisOffset,
      min: 0,
      minInterval: 1,
      name: "Players",
      nameTextStyle: { color: palette.textMuted, fontSize: 10, padding: [0, 0, 4, 0] },
      axisLine: { show: true, lineStyle: { color: palette.border } },
      axisTick: { show: false },
      axisLabel: { color: palette.textMuted, formatter: (value: number) => `${Math.round(value)}` },
      splitLine: { show: false }
    });
    rightAxisOffset += 48;
  }
  if (networkEnabled) {
    networkAxis = "timeline-network-axis";
    yAxis.push({
      id: networkAxis,
      type: "value",
      position: "right",
      offset: rightAxisOffset,
      min: 0,
      name: "Network",
      nameTextStyle: { color: palette.textMuted, fontSize: 10, padding: [0, 0, 4, 0] },
      axisLine: { show: true, lineStyle: { color: palette.border } },
      axisTick: { show: false },
      axisLabel: { color: palette.textMuted, formatter: (value: number) => `${formatBytes(value)}/s` },
      splitLine: { show: false }
    });
  }
  const emptyAxis = "timeline-empty-axis";
  if (!yAxis.length) yAxis.push({ id: emptyAxis, type: "value", show: false, min: 0, max: 1 });
  const annotationAxis = cpuAxis || memoryAxis || playersAxis || networkAxis || emptyAxis;
  const metricSeries: Array<{ key: SeriesKey; name: string; yAxisId: string; color: string; width: number; opacity: number; dash?: "solid" | "dashed"; step?: "end" }> = [
    { key: "cpuUtilizationPercent", name: "CPU", yAxisId: cpuAxis, color: palette.cpu, width: 2.4, opacity: 0.96 },
    { key: "memoryUtilizationPercent", name: "Memory", yAxisId: memoryAxis, color: palette.memory, width: 2.2, opacity: 0.9 },
    { key: "networkRxBytesPerSecond", name: "Network In", yAxisId: networkAxis, color: palette.networkIn, width: 1.25, opacity: 0.52 },
    { key: "networkTxBytesPerSecond", name: "Network Out", yAxisId: networkAxis, color: palette.networkOut, width: 1.25, opacity: 0.52 },
    { key: "playersOnline", name: "Players", yAxisId: playersAxis, color: palette.players, width: 1.6, opacity: 0.72, step: "end" }
  ];
  const markerLines: Array<{
    xAxis: number;
    lineStyle: { color: string; type: "solid" | "dashed"; width: number; opacity: number };
    label: { show: boolean; formatter?: string; color?: string; position?: string };
  }> = [];
  if (now >= viewport.from && now <= viewport.to) {
    markerLines.push({
      xAxis: now,
      lineStyle: { color: palette.accent, type: "dashed", width: 1.5, opacity: 0.8 },
      label: { show: true, formatter: "Now", color: palette.textMuted, position: "insideEndTop" }
    });
  }

  return {
    animation: false,
    aria: {
      enabled: true,
      description: `Server resource timeline with ${samples.length} samples and ${clusters.reduce((total, cluster) => total + cluster.markers.length, 0)} annotations.`
    },
    grid: { id: "timeline-grid", ...grid, containLabel: false },
    xAxis: {
      id: "timeline-time-axis",
      type: "time",
      min: query.from,
      max: query.to,
      axisLine: { lineStyle: { color: palette.border } },
      axisTick: { show: false },
      axisLabel: {
        color: palette.textMuted,
        hideOverlap: true,
        formatter: (value: number) => viewport.to - viewport.from >= 60 * 60 * 1000 ? formatShortTime(value) : formatTime(value)
      },
      splitLine: { show: false }
    },
    yAxis,
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
        yAxisId: series.yAxisId,
        data: samples.map((sample) => [sample.sampledAt, sample[series.key] ?? "-"]),
        symbol: "none",
        showSymbol: false,
        smooth: series.step ? false : series.key.startsWith("network") ? 0.36 : 0.24,
        smoothMonotone: "x" as const,
        step: series.step,
        connectNulls: false,
        silent: true,
        lineStyle: { color: series.color, width: series.width, opacity: series.opacity, type: series.dash ?? "solid", cap: "round", join: "round" },
        itemStyle: { color: series.color },
        emphasis: { disabled: true },
        animation: false
      })),
      {
        id: "timeline-annotations",
        name: "Timeline annotations",
        type: "line",
        yAxisId: annotationAxis,
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
