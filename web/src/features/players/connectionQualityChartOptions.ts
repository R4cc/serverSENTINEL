import type { EChartsCoreOption } from "echarts/core";
import type { PlayerLatencyPoint } from "../../types";
import { buildTimelineTimeAxisOption, escapeTimelineHtml, type TimelinePalette } from "../../components/serverTimelineChart";

export type ConnectionQualityPalette = Pick<TimelinePalette, "accent" | "text" | "textMuted" | "border" | "surface" | "fontFamily"> & {
  median: string;
};

export const defaultConnectionQualityPalette: ConnectionQualityPalette = {
  median: "#2c7a66",
  accent: "#4169ff",
  text: "#1f2530",
  textMuted: "#697386",
  border: "#d9dee8",
  surface: "#ffffff",
  fontFamily: "\"Switzer\", Inter, \"Helvetica Neue\", Helvetica, Arial, sans-serif"
};

export function connectionQualityCeiling(points: readonly PlayerLatencyPoint[]) {
  const values = points.flatMap((point) => [point.medianEstimatedLatencyMs, point.p95EstimatedLatencyMs]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value)));
  if (!values.length) return 50;
  return Math.max(50, Math.ceil(Math.max(...values) * 1.08 / 25) * 25);
}

export function connectionQualityTimeFormatters(timeZone: string, from: number, to: number) {
  const span = to - from;
  const date = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" });
  const time = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit" });
  const tooltip = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit"
  });
  return {
    axis: (value: string | number | Date) => span >= 3 * 24 * 60 * 60 * 1000
      ? date.format(new Date(value))
      : span >= 20 * 60 * 60 * 1000
        ? `${time.format(new Date(value))}\n${date.format(new Date(value))}`
        : time.format(new Date(value)),
    tooltip: (value: string | number | Date) => tooltip.format(new Date(value))
  };
}

type TooltipSeries = {
  seriesName?: unknown;
  value?: unknown;
  color?: unknown;
  axisValue?: unknown;
};

export function connectionQualityTooltipHtml(value: unknown, formatTime: (value: number) => string) {
  const entries = (Array.isArray(value) ? value : [value]) as TooltipSeries[];
  const timestamp = Number(entries[0]?.axisValue ?? (Array.isArray(entries[0]?.value) ? entries[0].value[0] : Number.NaN));
  const firstValue = entries.find((entry) => Array.isArray(entry.value))?.value as unknown[] | undefined;
  const players = Number(firstValue?.[2]);
  const rows = entries.flatMap((entry) => {
    if (!Array.isArray(entry.value)) return [];
    const latency = Number(entry.value[1]);
    if (!Number.isFinite(latency)) return [];
    const color = typeof entry.color === "string" ? entry.color : "currentColor";
    return [`<div class="playerConnectionTooltipRow"><i style="background:${escapeTimelineHtml(color)}"></i><span>${escapeTimelineHtml(entry.seriesName ?? "Estimate")}</span><strong>${Math.round(latency)} ms</strong></div>`];
  });
  return [
    `<strong class="playerConnectionTooltipTime">${escapeTimelineHtml(Number.isFinite(timestamp) ? formatTime(timestamp) : "Estimated latency")}</strong>`,
    ...rows,
    ...(Number.isFinite(players) ? [`<div class="playerConnectionTooltipPlayers">${Math.round(players)} active ${Math.round(players) === 1 ? "player" : "players"}</div>`] : [])
  ].join("");
}

export function buildConnectionQualityChartOption({
  points,
  timeZone,
  compact,
  palette
}: {
  points: readonly PlayerLatencyPoint[];
  timeZone: string;
  compact: boolean;
  palette: ConnectionQualityPalette;
}): EChartsCoreOption {
  const from = points[0].at;
  const to = points.at(-1)!.at;
  const ceiling = connectionQualityCeiling(points);
  const formatters = connectionQualityTimeFormatters(timeZone, from, to);
  const axisPalette: TimelinePalette = {
    ...palette,
    cpu: palette.accent,
    memory: palette.accent,
    networkIn: palette.accent,
    networkOut: palette.accent,
    players: palette.textMuted,
    join: palette.median,
    leave: palette.accent,
    server: palette.accent,
    automation: palette.accent
  };
  const series = [
    { id: "connection-median", name: "Median estimate", key: "medianEstimatedLatencyMs" as const, color: palette.median, width: 2.6, type: "solid" as const, area: 0.08 },
    { id: "connection-p95", name: "95th percentile", key: "p95EstimatedLatencyMs" as const, color: palette.accent, width: 1.8, type: "dashed" as const, area: 0 }
  ];

  return {
    animation: false,
    aria: {
      enabled: true,
      description: `Estimated connection quality over time with ${points.length} reconstructed samples.`
    },
    textStyle: { fontFamily: palette.fontFamily },
    grid: {
      id: "connection-quality-grid",
      left: compact ? 8 : 12,
      right: compact ? 8 : 14,
      top: 12,
      bottom: compact ? 8 : 10,
      containLabel: true
    },
    tooltip: {
      className: "playerConnectionTooltip",
      trigger: "axis",
      confine: true,
      appendToBody: false,
      backgroundColor: palette.surface,
      borderColor: palette.border,
      borderWidth: 1,
      padding: [9, 11],
      textStyle: { color: palette.text, fontFamily: palette.fontFamily, fontSize: 12 },
      axisPointer: { type: "line", lineStyle: { color: palette.textMuted, width: 1, type: "dashed", opacity: 0.7 } },
      formatter: (params: unknown) => connectionQualityTooltipHtml(params, (value) => formatters.tooltip(value))
    },
    xAxis: {
      ...buildTimelineTimeAxisOption({
        id: "connection-quality-time-axis",
        query: { from, to },
        viewport: { from, to },
        palette: axisPalette,
        formatTime: formatters.axis,
        formatShortTime: formatters.axis
      }),
      boundaryGap: false,
      axisLabel: {
        color: palette.textMuted,
        hideOverlap: true,
        margin: 10,
        fontSize: compact ? 11 : 10,
        formatter: (value: number) => formatters.axis(value)
      }
    },
    yAxis: {
      id: "connection-quality-latency-axis",
      type: "value",
      min: 0,
      max: ceiling,
      splitNumber: compact ? 3 : 4,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { color: palette.textMuted, margin: 10, fontSize: compact ? 11 : 10, formatter: (value: number) => `${Math.round(value)} ms` },
      splitLine: { lineStyle: { color: palette.border, type: "dashed", opacity: 0.72 } }
    },
    dataZoom: [],
    series: series.map((definition) => ({
      id: definition.id,
      name: definition.name,
      type: "line",
      data: points.map((point) => [point.at, point[definition.key] ?? "-", point.players]),
      symbol: "none",
      showSymbol: false,
      smooth: 0.22,
      smoothMonotone: "x",
      connectNulls: false,
      lineStyle: { color: definition.color, width: definition.width, type: definition.type, cap: "round", join: "round" },
      itemStyle: { color: definition.color },
      areaStyle: definition.area ? { color: definition.color, opacity: definition.area } : undefined,
      emphasis: { focus: "series", lineStyle: { width: definition.width + 0.7 } },
      animation: false
    }))
  };
}
