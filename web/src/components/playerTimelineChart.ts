import type {
  CustomElementOption,
  CustomSeriesRenderItem,
  CustomSeriesRenderItemReturn
} from "echarts/types/src/chart/custom/CustomSeries.js";
import type { EChartsCoreOption } from "echarts/core";
import type { ServerTimelinePlayerSession } from "../types";
import type { TimelinePalette } from "./serverTimelineChart";

export type PlayerTimelineWindow = { from: number; to: number };

export type PlayerTimelineRow = {
  player: string;
  online: boolean;
  sessions: ServerTimelinePlayerSession[];
};

export type TimelineSessionGeometry = {
  leftPercent: number;
  widthPercent: number;
  startClipped: boolean;
  endClipped: boolean;
  lowerBound: boolean;
  durationMs: number;
};

export type PlayerTimelineChartItem = {
  id: string;
  player: string;
  online: boolean;
  rowIndex: number;
  visibleStart: number;
  visibleEnd: number;
  exactStart: boolean;
  exactEnd: boolean;
  open: boolean;
  startClipped: boolean;
  endClipped: boolean;
  durationLabel: string;
  startLabel: string | null;
  endLabel: string | null;
  reconnects: Array<{
    at: number;
    offlineMs: number;
  }>;
  accessibleLabel: string;
};

type CartesianRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

type TextAlignment = "left" | "center" | "right";

export type PlayerTimelineLabelLayout = {
  durationX: number;
  startX: number;
  startAlign: TextAlignment;
  endX: number;
  endAlign: TextAlignment;
  showStart: boolean;
  showEnd: boolean;
};

export const playerTimelineRowHeight = 40;
export const playerTimelineReconnectWindowMs = 15 * 60_000;
const playerTimelineRightInset = 24;

export function timelineSessionGeometry(session: ServerTimelinePlayerSession, viewport: PlayerTimelineWindow, now: number): TimelineSessionGeometry | null {
  const sessionEnd = session.endedAt ?? now;
  const visibleStart = Math.max(session.startedAt, viewport.from);
  const visibleEnd = Math.min(sessionEnd, viewport.to);
  if (visibleEnd < visibleStart || viewport.to <= viewport.from) return null;
  const span = viewport.to - viewport.from;
  return {
    leftPercent: (visibleStart - viewport.from) / span * 100,
    widthPercent: Math.max(0.16, (visibleEnd - visibleStart) / span * 100),
    startClipped: session.startBoundary === "history-boundary" || session.startedAt < viewport.from,
    endClipped: session.endBoundary === "history-boundary" || sessionEnd > viewport.to,
    lowerBound: session.startBoundary === "history-boundary" || session.endBoundary === "history-boundary",
    durationMs: Math.max(0, sessionEnd - session.startedAt)
  };
}

export function formatTimelineDuration(milliseconds: number) {
  const totalMinutes = Math.max(0, Math.floor(milliseconds / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (totalMinutes) return `${totalMinutes}m`;
  return "<1m";
}

function estimatedTextWidth(value: string) {
  return value.length * 5.6 + 10;
}

export function playerTimelineLabelLayout({
  startX,
  endX,
  plotLeft,
  plotRight,
  durationLabel,
  startLabel,
  endLabel
}: {
  startX: number;
  endX: number;
  plotLeft: number;
  plotRight: number;
  durationLabel: string;
  startLabel: string | null;
  endLabel: string | null;
}): PlayerTimelineLabelLayout {
  const segmentWidth = Math.max(0, endX - startX);
  const durationHalfWidth = estimatedTextWidth(durationLabel) / 2;
  const durationX = Math.max(plotLeft + durationHalfWidth, Math.min(plotRight - durationHalfWidth, (startX + endX) / 2));
  const startWidth = startLabel ? estimatedTextWidth(startLabel) : 0;
  const endWidth = endLabel ? estimatedTextWidth(endLabel) : 0;
  const roomy = segmentWidth >= startWidth + endWidth + 20;

  if (roomy) {
    return {
      durationX,
      startX,
      startAlign: startX - startWidth / 2 < plotLeft ? "left" : "center",
      endX,
      endAlign: endX + endWidth / 2 > plotRight ? "right" : "center",
      showStart: Boolean(startLabel),
      showEnd: Boolean(endLabel)
    };
  }

  const startFitsOutside = Boolean(startLabel) && startX - startWidth - 7 >= plotLeft;
  const endFitsOutside = Boolean(endLabel) && endX + endWidth + 7 <= plotRight;
  return {
    durationX,
    startX: startFitsOutside ? startX - 7 : startX,
    startAlign: startFitsOutside ? "right" : "left",
    endX: endFitsOutside ? endX + 7 : endX,
    endAlign: endFitsOutside ? "left" : "right",
    showStart: Boolean(startLabel) && (startFitsOutside || !endLabel),
    showEnd: Boolean(endLabel) && (endFitsOutside || !startLabel || !startFitsOutside)
  };
}

export function playerTimelineChartItems(
  rows: PlayerTimelineRow[],
  viewport: PlayerTimelineWindow,
  now: number,
  formatShortTime: (value: string | number | Date) => string
): PlayerTimelineChartItem[] {
  return rows.flatMap((row, rowIndex) => {
    const sessionGroups = [...row.sessions]
      .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
      .reduce<ServerTimelinePlayerSession[][]>((groups, session) => {
        const current = groups.at(-1);
        const previous = current?.at(-1);
        const gap = previous?.endedAt === null || previous?.endedAt === undefined
          ? Number.POSITIVE_INFINITY
          : session.startedAt - previous.endedAt;
        const isQuickReconnect = previous?.endBoundary === "leave"
          && session.startBoundary === "join"
          && gap >= 0
          && gap <= playerTimelineReconnectWindowMs;
        if (current && isQuickReconnect) current.push(session);
        else groups.push([session]);
        return groups;
      }, []);

    return sessionGroups.flatMap((sessions) => {
      const firstSession = sessions[0];
      const lastSession = sessions.at(-1)!;
      const displaySession: ServerTimelinePlayerSession = {
        id: sessions.map((session) => session.id).join("+"),
        player: firstSession.player,
        startedAt: firstSession.startedAt,
        endedAt: lastSession.endedAt,
        startBoundary: firstSession.startBoundary,
        endBoundary: lastSession.endBoundary
      };
      const geometry = timelineSessionGeometry(displaySession, viewport, now);
      if (!geometry) return [];
      const sessionEnd = displaySession.endedAt ?? now;
      const visibleStart = Math.max(displaySession.startedAt, viewport.from);
      const visibleEnd = Math.min(sessionEnd, viewport.to);
      const exactStart = displaySession.startBoundary === "join" && displaySession.startedAt >= viewport.from;
      const exactEnd = (displaySession.endBoundary === "leave" || displaySession.endBoundary === "server-end")
        && displaySession.endedAt !== null
        && displaySession.endedAt <= viewport.to;
      const open = displaySession.endBoundary === "online" && now >= viewport.from && now <= viewport.to && visibleEnd === now;
      const activeDurationMs = sessions.reduce((total, session) => total + Math.max(0, (session.endedAt ?? now) - session.startedAt), 0);
      const durationLabel = `${geometry.lowerBound ? "≥ " : ""}${formatTimelineDuration(activeDurationMs)}${sessions.length > 1 ? " active" : ""}`;
      const startLabel = exactStart ? formatShortTime(displaySession.startedAt) : null;
      const endLabel = open ? "Now" : exactEnd && displaySession.endedAt !== null ? formatShortTime(displaySession.endedAt) : null;
      const reconnects = sessions.slice(1).flatMap((session, index) => {
        const previousEnd = sessions[index].endedAt;
        if (previousEnd === null || session.startedAt < viewport.from || session.startedAt > viewport.to) return [];
        return [{ at: session.startedAt, offlineMs: Math.max(0, session.startedAt - previousEnd) }];
      });
      const accessibleStart = startLabel ?? "before visible history";
      const accessibleEnd = open ? "online now" : endLabel ?? "outside visible history";
      const reconnectSummary = reconnects.length
        ? `; ${reconnects.length} ${reconnects.length === 1 ? "reconnect" : "reconnects"}`
        : "";
      return [{
        id: displaySession.id,
        player: row.player,
        online: row.online,
        rowIndex,
        visibleStart,
        visibleEnd,
        exactStart,
        exactEnd,
        open,
        startClipped: geometry.startClipped,
        endClipped: geometry.endClipped,
        durationLabel,
        startLabel,
        endLabel,
        reconnects,
        accessibleLabel: `${row.player}: ${accessibleStart} – ${accessibleEnd}; ${durationLabel}${reconnectSummary}`
      }];
    });
  });
}

function sessionRenderItem(items: PlayerTimelineChartItem[], palette: TimelinePalette): CustomSeriesRenderItem {
  return (params, api): CustomSeriesRenderItemReturn => {
    const itemIndex = Number(api.value(3));
    const item = items[itemIndex];
    if (!item) return null;
    const coordSys = params.coordSys as unknown as CartesianRect;
    const start = api.coord([item.visibleStart, item.rowIndex]);
    const end = api.coord([item.visibleEnd, item.rowIndex]);
    const plotLeft = coordSys.x;
    const plotRight = coordSys.x + coordSys.width;
    const startX = Math.max(plotLeft, Math.min(plotRight, start[0]));
    const endX = Math.max(startX + 1.5, Math.min(plotRight, end[0]));
    const y = start[1];
    const color = item.online ? palette.join : palette.leave;
    const labels = playerTimelineLabelLayout({
      startX,
      endX,
      plotLeft,
      plotRight,
      durationLabel: item.durationLabel,
      startLabel: item.startLabel,
      endLabel: item.endLabel
    });
    const children: CustomElementOption[] = [
      {
        type: "line",
        shape: { x1: startX, y1: y, x2: endX, y2: y },
        style: { stroke: color, lineWidth: 7, opacity: 0.1, lineCap: "round" },
        silent: true
      },
      {
        type: "line",
        shape: { x1: startX, y1: y, x2: endX, y2: y },
        style: { stroke: color, lineWidth: 2.25, opacity: 0.96, lineCap: "round" },
        silent: true
      }
    ];

    for (const reconnect of item.reconnects) {
      const reconnectX = Math.max(plotLeft, Math.min(plotRight, api.coord([reconnect.at, item.rowIndex])[0]));
      children.push({
        type: "circle",
        name: `Reconnected after ${formatTimelineDuration(reconnect.offlineMs)} offline`,
        shape: { cx: reconnectX, cy: y, r: 4.2 },
        style: { fill: color, stroke: palette.surface, lineWidth: 1.7 },
        silent: true
      });
    }

    if (item.startClipped) {
      children.push({
        type: "polygon",
        shape: { points: [[plotLeft, y], [plotLeft + 8, y - 4], [plotLeft + 8, y + 4]] },
        style: { fill: color, opacity: 0.9 },
        silent: true
      });
    } else {
      children.push({
        type: "circle",
        shape: { cx: startX, cy: y, r: 4.2 },
        style: { fill: color, stroke: palette.surface, lineWidth: 1.5 },
        silent: true
      });
    }

    if (item.endClipped) {
      children.push({
        type: "polygon",
        shape: { points: [[plotRight, y], [plotRight - 8, y - 4], [plotRight - 8, y + 4]] },
        style: { fill: color, opacity: 0.9 },
        silent: true
      });
    } else {
      if (item.open) {
        children.push({
          type: "circle",
          shape: { cx: endX, cy: y, r: 7.5 },
          style: { fill: color, opacity: 0.13 },
          silent: true
        });
      }
      children.push({
        type: "circle",
        shape: { cx: endX, cy: y, r: 4.2 },
        style: { fill: palette.surface, stroke: color, lineWidth: 1.7 },
        silent: true
      });
    }

    children.push({
      type: "text",
      style: {
        x: labels.durationX,
        y: y - 8,
        text: item.durationLabel,
        align: "center",
        verticalAlign: "bottom",
        fill: palette.text,
        font: "600 9px Inter, system-ui, sans-serif",
        backgroundColor: palette.surface,
        borderRadius: 5,
        padding: [2, 5]
      },
      silent: true
    });
    if (labels.showStart && item.startLabel) {
      children.push({
        type: "text",
        style: {
          x: labels.startX,
          y: y + 8,
          text: item.startLabel,
          align: labels.startAlign,
          verticalAlign: "top",
          fill: palette.textMuted,
          font: "9px Inter, system-ui, sans-serif"
        },
        silent: true
      });
    }
    if (labels.showEnd && item.endLabel) {
      children.push({
        type: "text",
        style: {
          x: labels.endX,
          y: y + 8,
          text: item.endLabel,
          align: labels.endAlign,
          verticalAlign: "top",
          fill: item.open ? color : palette.textMuted,
          font: `${item.open ? "600 " : ""}9px Inter, system-ui, sans-serif`
        },
        silent: true
      });
    }

    return {
      type: "group",
      name: item.accessibleLabel,
      children,
      emphasisDisabled: true
    };
  };
}

function nowGuideRenderItem(now: number, palette: TimelinePalette): CustomSeriesRenderItem {
  return (params, api): CustomSeriesRenderItemReturn => {
    const coordSys = params.coordSys as unknown as CartesianRect;
    const x = api.coord([now, 0])[0];
    if (x < coordSys.x || x > coordSys.x + coordSys.width) return null;
    return {
      type: "line",
      shape: { x1: x, y1: coordSys.y, x2: x, y2: coordSys.y + coordSys.height },
      style: { stroke: palette.accent, lineWidth: 1.25, lineDash: [4, 4], opacity: 0.72 },
      silent: true
    };
  };
}

export function buildPlayerTimelineChartOption({
  rows,
  query,
  viewport,
  now,
  palette,
  formatShortTime
}: {
  rows: PlayerTimelineRow[];
  query: PlayerTimelineWindow;
  viewport: PlayerTimelineWindow;
  now: number;
  palette: TimelinePalette;
  formatShortTime: (value: string | number | Date) => string;
}): EChartsCoreOption {
  const items = playerTimelineChartItems(rows, viewport, now, formatShortTime);
  const nowVisible = now >= viewport.from && now <= viewport.to;
  return {
    animation: false,
    aria: {
      enabled: true,
      description: `Player session timeline with ${rows.length} players and ${items.length} visible sessions.`
    },
    grid: { id: "player-timeline-grid", left: 0, right: playerTimelineRightInset, top: 0, bottom: 0, containLabel: false },
    xAxis: {
      id: "player-timeline-time-axis",
      type: "time",
      min: query.from,
      max: query.to,
      show: false,
      splitNumber: 6
    },
    yAxis: {
      id: "player-timeline-row-axis",
      type: "category",
      inverse: true,
      data: rows.map((row) => row.player),
      show: false,
      axisTick: { show: false },
      axisLine: { show: false },
      splitLine: { show: true, lineStyle: { color: palette.border, width: 1, opacity: 0.62 } }
    },
    dataZoom: [{
      id: "player-timeline-inside",
      type: "inside",
      xAxisIndex: 0,
      startValue: viewport.from,
      endValue: viewport.to,
      filterMode: "weakFilter",
      zoomOnMouseWheel: false,
      moveOnMouseMove: false,
      moveOnMouseWheel: false,
      preventDefaultMouseMove: false
    }],
    series: [
      {
        id: "player-sessions",
        name: "Player sessions",
        type: "custom",
        coordinateSystem: "cartesian2d",
        renderItem: sessionRenderItem(items, palette),
        dimensions: ["start", "end", "player", "itemIndex"],
        encode: { x: [0, 1], y: 2 },
        data: items.map((item, index) => [item.visibleStart, item.visibleEnd, item.rowIndex, index]),
        silent: true,
        animation: false,
        clip: true
      },
      ...(nowVisible ? [{
        id: "player-now-guide",
        name: "Current time",
        type: "custom" as const,
        coordinateSystem: "cartesian2d",
        renderItem: nowGuideRenderItem(now, palette),
        encode: { x: [0, 1], y: 2 },
        data: [[now, now, 0]],
        silent: true,
        animation: false,
        clip: true
      }] : [])
    ]
  };
}
