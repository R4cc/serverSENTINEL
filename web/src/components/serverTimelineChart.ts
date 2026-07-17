import type { EChartsCoreOption } from "echarts/core";
import type { ServerTimelineResourcePoint } from "../types";
import type { MarkerCluster, SeriesKey, TimelineWindow } from "./ServerTimeline";

export const timelineRetentionMs = 24 * 60 * 60 * 1000;
export const timelineChartGrid = { left: 56, right: 24, top: 60, bottom: 38 } as const;

export function timelineChartGridForEnabled(enabled: Record<SeriesKey, boolean>) {
  const percentage = enabled.cpuUtilizationPercent || enabled.memoryUtilizationPercent;
  const network = enabled.networkRxBytesPerSecond || enabled.networkTxBytesPerSecond;
  const players = enabled.playersOnline;
  const visibleRightAxes = Number(network) + Number(players);
  return {
    ...timelineChartGrid,
    left: percentage ? 56 : 24,
    right: visibleRightAxes === 2 ? 128 : visibleRightAxes === 1 ? 76 : 24
  };
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
  formatShortTime,
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
  formatShortTime: (value: string | number | Date) => string;
  reducedMotion: boolean;
  now: number;
}): EChartsCoreOption {
  const grid = timelineChartGridForEnabled(enabled);
  const percentageEnabled = enabled.cpuUtilizationPercent || enabled.memoryUtilizationPercent;
  const networkEnabled = enabled.networkRxBytesPerSecond || enabled.networkTxBytesPerSecond;
  const playersEnabled = enabled.playersOnline;
  const yAxis: Array<Record<string, unknown>> = [];
  let percentageAxis = -1;
  let networkAxis = -1;
  let playersAxis = -1;
  if (percentageEnabled) {
    percentageAxis = yAxis.length;
    yAxis.push({
      type: "value",
      position: "left",
      min: 0,
      max: 100,
      name: enabled.cpuUtilizationPercent && enabled.memoryUtilizationPercent ? "CPU / Memory" : enabled.cpuUtilizationPercent ? "CPU" : "Memory",
      nameTextStyle: { color: palette.textMuted, fontSize: 10, padding: [0, 0, 4, 0] },
      axisLine: { show: true, lineStyle: { color: palette.border } },
      axisTick: { show: false },
      axisLabel: { color: palette.textMuted, formatter: (value: number) => `${value.toFixed(0)}%` },
      splitLine: { lineStyle: { color: palette.border, type: "dashed", opacity: 0.7 } }
    });
  }
  if (playersEnabled) {
    playersAxis = yAxis.length;
    yAxis.push({
      type: "value",
      position: "right",
      min: 0,
      minInterval: 1,
      name: "Players",
      nameTextStyle: { color: palette.textMuted, fontSize: 10, padding: [0, 0, 4, 0] },
      axisLine: { show: true, lineStyle: { color: palette.border } },
      axisTick: { show: false },
      axisLabel: { color: palette.textMuted, formatter: (value: number) => `${Math.round(value)}` },
      splitLine: { show: false }
    });
  }
  if (networkEnabled) {
    networkAxis = yAxis.length;
    yAxis.push({
      type: "value",
      position: "right",
      offset: playersEnabled ? 48 : 0,
      min: 0,
      name: "Network",
      nameTextStyle: { color: palette.textMuted, fontSize: 10, padding: [0, 0, 4, 0] },
      axisLine: { show: true, lineStyle: { color: palette.border } },
      axisTick: { show: false },
      axisLabel: { color: palette.textMuted, formatter: (value: number) => `${formatBytes(value)}/s` },
      splitLine: { show: false }
    });
  }
  if (!yAxis.length) yAxis.push({ type: "value", show: false, min: 0, max: 1 });
  const metricSeries: Array<{ key: SeriesKey; name: string; yAxisIndex: number; color: string; width: number; opacity: number; dash?: "solid" | "dashed"; step?: "end" }> = [
    { key: "cpuUtilizationPercent", name: "CPU", yAxisIndex: percentageAxis, color: palette.cpu, width: 2.4, opacity: 0.96 },
    { key: "memoryUtilizationPercent", name: "Memory", yAxisIndex: percentageAxis, color: palette.memory, width: 2.2, opacity: 0.9 },
    { key: "networkRxBytesPerSecond", name: "Network In", yAxisIndex: networkAxis, color: palette.networkIn, width: 1.25, opacity: 0.52 },
    { key: "networkTxBytesPerSecond", name: "Network Out", yAxisIndex: networkAxis, color: palette.networkOut, width: 1.25, opacity: 0.52 },
    { key: "playersOnline", name: "Players", yAxisIndex: playersAxis, color: palette.players, width: 1.6, opacity: 0.72, step: "end" }
  ];
  const markerLines: Array<{
    xAxis: number;
    lineStyle: { color: string; type: "solid" | "dashed"; width: number; opacity: number };
    label: { show: boolean; formatter?: string; color?: string; position?: string };
  }> = clusters.map((cluster) => ({
    xAxis: cluster.occurredAt,
    lineStyle: {
      color: markerColor(cluster, palette),
      type: cluster.markers.every((marker) => marker.tone === "planned") ? "dashed" as const : "solid" as const,
      width: Math.min(5, 2.5 + (cluster.markers.length - 1) * 0.75),
      opacity: 0.84
    },
    label: { show: false }
  }));
  if (now >= viewport.from && now <= viewport.to) {
    markerLines.push({
      xAxis: now,
      lineStyle: { color: palette.accent, type: "dashed", width: 1.5, opacity: 0.8 },
      label: { show: true, formatter: "Now", color: palette.textMuted, position: "insideEndTop" }
    });
  }

  return {
    animation: !reducedMotion,
    aria: {
      enabled: true,
      description: `Server resource timeline with ${samples.length} samples and ${clusters.reduce((total, cluster) => total + cluster.markers.length, 0)} annotations.`
    },
    grid: { ...grid, containLabel: false },
    xAxis: {
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
        yAxisIndex: series.yAxisIndex,
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
