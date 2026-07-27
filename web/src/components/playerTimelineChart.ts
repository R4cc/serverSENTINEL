import type {
  CustomElementOption,
  CustomSeriesRenderItem,
  CustomSeriesRenderItemReturn
} from "echarts/types/src/chart/custom/CustomSeries.js";
import { format, type EChartsCoreOption } from "echarts/core";
import type { ServerTimelinePlayerSession } from "../types";
import { playerEventIconShapes, type PlayerEventIconKind } from "./EventIcon";
import {
  buildTimelineTimeAxisOption,
  buildTimelineTimeDataZoomOption,
  type TimelinePalette
} from "./serverTimelineChart";

export type PlayerTimelineWindow = { from: number; to: number };

export type PlayerTimelineRow = {
  player: string;
  online: boolean;
  sessions: ServerTimelinePlayerSession[];
};

export type PlayerTimelineGroupLane = {
  key: "group:online" | "group:offline";
  kind: "group";
  online: boolean;
  label: "Online now" | "Played in this time range";
  count: number;
};

export type PlayerTimelinePlayerLane = {
  key: string;
  kind: "player";
  online: boolean;
  player: string;
  row: PlayerTimelineRow;
};

export type PlayerTimelineLane = PlayerTimelineGroupLane | PlayerTimelinePlayerLane;

export type PlayerTimelineLanePosition = {
  startKey?: string;
  startIndex: number;
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
  laneKey: string;
  startedAt: number;
  endedAt: number;
  startBoundary: ServerTimelinePlayerSession["startBoundary"];
  endBoundary: ServerTimelinePlayerSession["endBoundary"];
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
  fullStartLabel: string | null;
  fullEndLabel: string | null;
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
export const playerTimelineAxisHeight = 30;
export const playerTimelineVisibleLaneCount = 6;
export const playerTimelineReconnectWindowMs = 15 * 60_000;
export const playerTimelineTimeDataZoomId = "player-timeline-time";
export const playerTimelineRowsDataZoomId = "player-timeline-rows";
export const playerTimelineRowsSliderId = "player-timeline-rows-slider";

function playerTimelineKey(player: string) {
  return player.trim().toLocaleLowerCase();
}

function playerTimelineLaneKey(row: Pick<PlayerTimelineRow, "player" | "online">) {
  return `player:${playerTimelineKey(row.player)}`;
}

export function playerTimelineLanes(rows: PlayerTimelineRow[]): PlayerTimelineLane[] {
  const byName = (left: PlayerTimelineRow, right: PlayerTimelineRow) => left.player.localeCompare(right.player, undefined, { sensitivity: "base" });
  const onlineRows = rows.filter((row) => row.online).sort(byName);
  const offlineRows = rows.filter((row) => !row.online).sort(byName);
  return [
    ...(onlineRows.length ? [{ key: "group:online", kind: "group", online: true, label: "Online now", count: onlineRows.length } as const] : []),
    ...onlineRows.map((row): PlayerTimelinePlayerLane => ({ key: playerTimelineLaneKey(row), kind: "player", online: true, player: row.player, row })),
    ...(offlineRows.length ? [{ key: "group:offline", kind: "group", online: false, label: "Played in this time range", count: offlineRows.length } as const] : []),
    ...offlineRows.map((row): PlayerTimelinePlayerLane => ({ key: playerTimelineLaneKey(row), kind: "player", online: false, player: row.player, row }))
  ];
}

export function resolvePlayerTimelineLaneWindow(
  lanes: PlayerTimelineLane[],
  position: PlayerTimelineLanePosition = { startIndex: 0 },
  visibleCount = playerTimelineVisibleLaneCount
) {
  const count = Math.max(1, Math.min(visibleCount, lanes.length || 1));
  const keyedIndex = position.startKey ? lanes.findIndex((lane) => lane.key === position.startKey) : -1;
  const requestedIndex = keyedIndex >= 0 ? keyedIndex : position.startIndex;
  const startIndex = Math.max(0, Math.min(Math.max(0, lanes.length - count), requestedIndex));
  const endIndex = Math.max(startIndex, Math.min(lanes.length - 1, startIndex + count - 1));
  return {
    startIndex,
    endIndex,
    startKey: lanes[startIndex]?.key,
    endKey: lanes[endIndex]?.key,
    visibleCount: count
  };
}

export function preservePlayerTimelineLanePosition(
  previousLanes: PlayerTimelineLane[],
  nextLanes: PlayerTimelineLane[],
  position: PlayerTimelineLanePosition
): PlayerTimelineLanePosition {
  if (!nextLanes.length) return { startIndex: 0 };
  const nextIndexByKey = new Map(nextLanes.map((lane, index) => [lane.key, index]));
  const previousWindow = resolvePlayerTimelineLaneWindow(previousLanes, position);
  const anchorKey = previousWindow.startKey ?? position.startKey;
  const survivingIndex = anchorKey ? nextIndexByKey.get(anchorKey) : undefined;
  if (survivingIndex !== undefined) return { startKey: anchorKey, startIndex: survivingIndex };

  const anchorIndex = anchorKey
    ? previousLanes.findIndex((lane) => lane.key === anchorKey)
    : Math.max(0, Math.min(previousLanes.length - 1, position.startIndex));
  for (let index = Math.max(0, anchorIndex + 1); index < previousLanes.length; index += 1) {
    const nextIndex = nextIndexByKey.get(previousLanes[index].key);
    if (nextIndex !== undefined) return { startKey: previousLanes[index].key, startIndex: nextIndex };
  }
  for (let index = Math.min(previousLanes.length - 1, anchorIndex - 1); index >= 0; index -= 1) {
    const nextIndex = nextIndexByKey.get(previousLanes[index].key);
    if (nextIndex !== undefined) return { startKey: previousLanes[index].key, startIndex: nextIndex };
  }
  return { startKey: nextLanes[0].key, startIndex: 0 };
}

export function playerTimelineLanePositionFromZoom(
  event: { dataZoomId?: string; start?: number; startValue?: unknown; batch?: Array<{ dataZoomId?: string; start?: number; startValue?: unknown }> },
  lanes: PlayerTimelineLane[]
): PlayerTimelineLanePosition | null {
  const candidates = event.batch ?? [event];
  const zoom = candidates.find((candidate) => candidate.dataZoomId === playerTimelineRowsDataZoomId || candidate.dataZoomId === playerTimelineRowsSliderId);
  if (!zoom || !lanes.length) return null;
  if (typeof zoom.startValue === "string") {
    const index = lanes.findIndex((lane) => lane.key === zoom.startValue);
    if (index >= 0) return { startKey: lanes[index].key, startIndex: index };
  }
  const numericStartValue = Number(zoom.startValue);
  if (Number.isInteger(numericStartValue) && numericStartValue >= 0 && numericStartValue < lanes.length) {
    return { startKey: lanes[numericStartValue].key, startIndex: numericStartValue };
  }
  const start = Number(zoom.start);
  if (!Number.isFinite(start)) return null;
  const index = Math.max(0, Math.min(lanes.length - 1, Math.round(start / 100 * Math.max(0, lanes.length - 1))));
  return { startKey: lanes[index].key, startIndex: index };
}

export function playerTimelineChartHeight(laneCount: number) {
  return playerTimelineAxisHeight + Math.max(1, Math.min(playerTimelineVisibleLaneCount, laneCount)) * playerTimelineRowHeight;
}

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

export function playerTimelineLabelLayout({
  startX,
  endX,
  plotLeft,
  plotRight,
  durationWidth,
  startWidth,
  endWidth,
  hasStart,
  hasEnd
}: {
  startX: number;
  endX: number;
  plotLeft: number;
  plotRight: number;
  durationWidth: number;
  startWidth: number;
  endWidth: number;
  hasStart: boolean;
  hasEnd: boolean;
}): PlayerTimelineLabelLayout {
  const segmentWidth = Math.max(0, endX - startX);
  const durationHalfWidth = durationWidth / 2;
  const durationX = Math.max(plotLeft + durationHalfWidth, Math.min(plotRight - durationHalfWidth, (startX + endX) / 2));
  const roomy = segmentWidth >= startWidth + endWidth + 20;

  if (roomy) {
    return {
      durationX,
      startX,
      startAlign: startX - startWidth / 2 < plotLeft ? "left" : "center",
      endX,
      endAlign: endX + endWidth / 2 > plotRight ? "right" : "center",
      showStart: hasStart,
      showEnd: hasEnd
    };
  }

  const startFitsOutside = hasStart && startX - startWidth - 7 >= plotLeft;
  const endFitsOutside = hasEnd && endX + endWidth + 7 <= plotRight;
  return {
    durationX,
    startX: startFitsOutside ? startX - 7 : startX,
    startAlign: startFitsOutside ? "right" : "left",
    endX: endFitsOutside ? endX + 7 : endX,
    endAlign: endFitsOutside ? "left" : "right",
    showStart: hasStart && (startFitsOutside || !hasEnd),
    showEnd: hasEnd && (endFitsOutside || !hasStart || !startFitsOutside)
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
      const durationKnown = sessions.every((session) =>
        session.startBoundary === "join" && session.endBoundary !== "history-boundary"
      );
      const activeDurationMs = sessions.reduce((total, session) => total + Math.max(0, (session.endedAt ?? now) - session.startedAt), 0);
      const durationLabel = durationKnown
        ? `${formatTimelineDuration(activeDurationMs)}${sessions.length > 1 ? " active" : ""}`
        : "Duration unavailable";
      const fullStartLabel = displaySession.startBoundary === "join" ? formatShortTime(displaySession.startedAt) : null;
      const fullEndLabel = displaySession.endBoundary === "online"
        ? "Now"
        : (displaySession.endBoundary === "leave" || displaySession.endBoundary === "server-end") && displaySession.endedAt !== null
          ? formatShortTime(displaySession.endedAt)
          : null;
      const startLabel = exactStart ? fullStartLabel : null;
      const endLabel = open || exactEnd ? fullEndLabel : null;
      const reconnects = sessions.slice(1).flatMap((session, index) => {
        const previousEnd = sessions[index].endedAt;
        if (previousEnd === null || session.startedAt < viewport.from || session.startedAt > viewport.to) return [];
        return [{ at: session.startedAt, offlineMs: Math.max(0, session.startedAt - previousEnd) }];
      });
      const accessibleStart = startLabel ?? (displaySession.startBoundary === "history-boundary" || displaySession.startedAt < viewport.from ? "before visible history" : fullStartLabel ?? "unknown start");
      const accessibleEnd = open ? "online now" : endLabel ?? (sessionEnd > viewport.to || displaySession.endBoundary === "history-boundary" ? "outside visible history" : fullEndLabel ?? "unknown end");
      const reconnectSummary = reconnects.length
        ? `; ${reconnects.length} ${reconnects.length === 1 ? "reconnect" : "reconnects"}`
        : "";
      return [{
        id: displaySession.id,
        player: row.player,
        online: row.online,
        rowIndex,
        laneKey: playerTimelineLaneKey(row),
        startedAt: displaySession.startedAt,
        endedAt: sessionEnd,
        startBoundary: displaySession.startBoundary,
        endBoundary: displaySession.endBoundary,
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
        fullStartLabel,
        fullEndLabel,
        reconnects,
        accessibleLabel: `${row.player}: ${accessibleStart} – ${accessibleEnd}; ${durationLabel}${reconnectSummary}`
      }];
    });
  });
}

function rowChromeRenderItem(
  lanes: PlayerTimelineLane[],
  query: PlayerTimelineWindow,
  palette: TimelinePalette,
  playerHeadSource?: (player: string) => string
): CustomSeriesRenderItem {
  return (params, api): CustomSeriesRenderItemReturn => {
    const lane = lanes[params.dataIndex];
    if (!lane) return null;
    const coordSys = params.coordSys as unknown as CartesianRect;
    const y = api.coord([query.from, lane.key])[1];
    const rawSize = api.size?.([0, 1]);
    const measuredBand = Math.abs(Number(Array.isArray(rawSize) ? rawSize[1] : rawSize));
    const bandHeight = Number.isFinite(measuredBand) && measuredBand > 0 ? measuredBand : playerTimelineRowHeight;
    const top = y - bandHeight / 2;
    const plotRight = coordSys.x + coordSys.width;
    const color = lane.online ? palette.join : palette.leave;

    if (lane.kind === "group") {
      return {
        type: "group",
        name: `${lane.label}, ${lane.count} players`,
        children: [
          {
            type: "rect",
            shape: { x: 0, y: top + 0.5, width: plotRight, height: Math.max(1, bandHeight - 1) },
            style: { fill: color, opacity: 0.055 },
            silent: true
          },
          {
            type: "rect",
            shape: { x: 0, y: top + 0.5, width: 4, height: Math.max(1, bandHeight - 1) },
            style: { fill: color },
            silent: true
          },
          {
            type: "text",
            style: {
              x: 12,
              y,
              text: `${lane.label.toUpperCase()} (${lane.count})`,
              align: "left",
              verticalAlign: "middle",
              fill: color,
              font: `600 10px ${palette.fontFamily}`
            },
            silent: true
          },
          {
            type: "line",
            shape: { x1: 0, y1: top + bandHeight - 0.5, x2: plotRight, y2: top + bandHeight - 0.5 },
            style: { stroke: palette.border, lineWidth: 1, opacity: 0.75 },
            silent: true
          }
        ]
      };
    }

    const badgeRadius = Math.max(8, Math.min(11, bandHeight * 0.275));
    // The overview roster rounds a 24px head by 4px; keep that ratio at this size.
    const badgeCornerRadius = Math.max(3, badgeRadius / 3);
    const badgeX = 22;
    const iconSize = badgeRadius * 1.28;
    const headSize = badgeRadius * 1.4;
    const iconX = badgeX - iconSize / 2;
    const iconY = y - iconSize / 2;
    const iconKind: PlayerEventIconKind = lane.online ? "player_joined" : "player_left";
    const headSource = playerHeadSource?.(lane.player);
    const iconChildren: CustomElementOption[] = headSource ? [] : playerEventIconShapes[iconKind].map((shape) => shape.type === "circle"
      ? {
          type: "circle",
          shape: {
            cx: iconX + shape.cx / 24 * iconSize,
            cy: iconY + shape.cy / 24 * iconSize,
            r: shape.r / 24 * iconSize
          },
          style: { fill: "none", stroke: color, lineWidth: 1.35 },
          silent: true
        }
      : {
          type: "path",
          shape: { pathData: shape.d, x: iconX, y: iconY, width: iconSize, height: iconSize },
          style: { fill: "none", stroke: color, lineWidth: 1.35, lineCap: "round", lineJoin: "round" },
          silent: true
        });

    return {
      type: "group",
      name: `${lane.player}, ${lane.online ? "online now" : "offline now"}`,
      children: [
        {
          type: "line",
          shape: { x1: 0, y1: top + bandHeight - 0.5, x2: plotRight, y2: top + bandHeight - 0.5 },
          style: { stroke: palette.border, lineWidth: 1, opacity: 0.5 },
          silent: true
        },
        {
          type: "line",
          shape: { x1: coordSys.x, y1: top, x2: coordSys.x, y2: top + bandHeight },
          style: { stroke: palette.border, lineWidth: 1 },
          silent: true
        },
        {
          // Rounded square rather than a disc, so the frame matches the shape of the
          // player head it holds and the roster tiles on the overview.
          type: "rect",
          shape: {
            x: badgeX - badgeRadius,
            y: y - badgeRadius,
            width: badgeRadius * 2,
            height: badgeRadius * 2,
            r: badgeCornerRadius
          },
          style: { fill: palette.surface, stroke: color, lineWidth: 1.5 },
          silent: true
        },
        ...iconChildren,
        ...(headSource ? [{
          type: "image" as const,
          style: {
            image: headSource,
            x: badgeX - headSize / 2,
            y: y - headSize / 2,
            width: headSize,
            height: headSize
          },
          silent: true
        }] : []),
        {
          type: "text",
          style: {
            x: badgeX + badgeRadius + 8,
            y,
            width: Math.max(0, coordSys.x - badgeX - badgeRadius - 20),
            overflow: "truncate",
            ellipsis: "…",
            text: lane.player,
            align: "left",
            verticalAlign: "middle",
            fill: palette.text,
            font: `600 11px ${palette.fontFamily}`
          },
          silent: true
        }
      ]
    };
  };
}

function sessionRenderItem(items: PlayerTimelineChartItem[], palette: TimelinePalette): CustomSeriesRenderItem {
  return (params, api): CustomSeriesRenderItemReturn => {
    const item = items[Number(api.value(3))];
    if (!item) return null;
    const coordSys = params.coordSys as unknown as CartesianRect;
    const rawStartX = api.coord([item.startedAt, item.laneKey])[0];
    const rawEndX = api.coord([item.endedAt, item.laneKey])[0];
    const plotLeft = coordSys.x;
    const plotRight = coordSys.x + coordSys.width;
    const startX = Math.max(plotLeft, Math.min(plotRight, rawStartX));
    const endX = Math.max(startX + 1.5, Math.min(plotRight, rawEndX));
    const y = api.coord([item.startedAt, item.laneKey])[1];
    const color = item.online ? palette.join : palette.leave;
    const startClipped = item.startBoundary === "history-boundary" || rawStartX < plotLeft;
    const endClipped = item.endBoundary === "history-boundary" || rawEndX > plotRight;
    const exactStart = item.startBoundary === "join" && rawStartX >= plotLeft && rawStartX <= plotRight;
    const exactEnd = (item.endBoundary === "leave" || item.endBoundary === "server-end") && rawEndX >= plotLeft && rawEndX <= plotRight;
    const open = item.endBoundary === "online" && rawEndX >= plotLeft && rawEndX <= plotRight;
    const startLabel = exactStart ? item.fullStartLabel : null;
    const endLabel = open || exactEnd ? item.fullEndLabel : null;
    const durationFont = `600 9px ${palette.fontFamily}`;
    const endpointFont = `9px ${palette.fontFamily}`;
    const labels = playerTimelineLabelLayout({
      startX,
      endX,
      plotLeft,
      plotRight,
      durationWidth: format.getTextRect(item.durationLabel, durationFont).width + 10,
      startWidth: startLabel ? format.getTextRect(startLabel, endpointFont).width : 0,
      endWidth: endLabel ? format.getTextRect(endLabel, endpointFont).width : 0,
      hasStart: Boolean(startLabel),
      hasEnd: Boolean(endLabel)
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
      const reconnectX = api.coord([reconnect.at, item.laneKey])[0];
      if (reconnectX < plotLeft || reconnectX > plotRight) continue;
      children.push({
        type: "circle",
        name: `Reconnected after ${formatTimelineDuration(reconnect.offlineMs)} offline`,
        shape: { cx: reconnectX, cy: y, r: 4.2 },
        style: { fill: color, stroke: palette.surface, lineWidth: 1.7 },
        silent: true
      });
    }

    if (startClipped) {
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

    if (endClipped) {
      children.push({
        type: "polygon",
        shape: { points: [[plotRight, y], [plotRight - 8, y - 4], [plotRight - 8, y + 4]] },
        style: { fill: color, opacity: 0.9 },
        silent: true
      });
    } else {
      if (open) {
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
        font: durationFont,
        backgroundColor: palette.surface,
        borderRadius: 5,
        padding: [2, 5]
      },
      silent: true
    });
    if (labels.showStart && startLabel) {
      children.push({
        type: "text",
        style: {
          x: labels.startX,
          y: y + 8,
          text: startLabel,
          align: labels.startAlign,
          verticalAlign: "top",
          fill: palette.textMuted,
          font: endpointFont
        },
        silent: true
      });
    }
    if (labels.showEnd && endLabel) {
      children.push({
        type: "text",
        style: {
          x: labels.endX,
          y: y + 8,
          text: endLabel,
          align: labels.endAlign,
          verticalAlign: "top",
          fill: open ? color : palette.textMuted,
          font: `${open ? "600 " : ""}${endpointFont}`
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
  lanes = playerTimelineLanes(rows),
  query,
  viewport,
  verticalPosition = { startIndex: 0 },
  now,
  palette,
  formatTime,
  formatShortTime,
  gridLeft = 220,
  playerHeadSource
}: {
  rows: PlayerTimelineRow[];
  lanes?: PlayerTimelineLane[];
  query: PlayerTimelineWindow;
  viewport: PlayerTimelineWindow;
  verticalPosition?: PlayerTimelineLanePosition;
  now: number;
  palette: TimelinePalette;
  formatTime?: (value: string | number | Date) => string;
  formatShortTime: (value: string | number | Date) => string;
  gridLeft?: number;
  playerHeadSource?: (player: string) => string;
}): EChartsCoreOption {
  const effectiveFormatTime = formatTime ?? formatShortTime;
  const items = playerTimelineChartItems(rows, viewport, now, formatShortTime);
  const nowVisible = now >= viewport.from && now <= viewport.to;
  const laneWindow = resolvePlayerTimelineLaneWindow(lanes, verticalPosition);
  const visibleLaneKeys = new Set(lanes.slice(laneWindow.startIndex, laneWindow.endIndex + 1).map((lane) => lane.key));
  const visiblePlayers = lanes
    .slice(laneWindow.startIndex, laneWindow.endIndex + 1)
    .filter((lane): lane is PlayerTimelinePlayerLane => lane.kind === "player");
  const visibleDescriptions = visiblePlayers.flatMap((lane) => {
    const sessions = items.filter((item) => item.laneKey === lane.key).map((item) => item.accessibleLabel);
    return sessions.length ? sessions : [`${lane.player}: ${lane.online ? "online now" : "offline now"}; no visible session range`];
  });
  const onlineCount = lanes.find((lane): lane is PlayerTimelineGroupLane => lane.kind === "group" && lane.online)?.count ?? 0;
  const offlineCount = lanes.find((lane): lane is PlayerTimelineGroupLane => lane.kind === "group" && !lane.online)?.count ?? 0;
  const hasVerticalOverflow = lanes.length > laneWindow.visibleCount;
  const dataZoom: Array<Record<string, unknown>> = [
    buildTimelineTimeDataZoomOption({ id: playerTimelineTimeDataZoomId, viewport, filterMode: "weakFilter" })
  ];
  if (hasVerticalOverflow && laneWindow.startKey && laneWindow.endKey) {
    dataZoom.push(
      {
        id: playerTimelineRowsDataZoomId,
        type: "inside",
        yAxisIndex: 0,
        startValue: laneWindow.startKey,
        endValue: laneWindow.endKey,
        filterMode: "weakFilter",
        zoomLock: true,
        zoomOnMouseWheel: false,
        moveOnMouseWheel: true,
        moveOnMouseMove: false,
        preventDefaultMouseMove: false
      },
      {
        id: playerTimelineRowsSliderId,
        type: "slider",
        yAxisIndex: 0,
        orient: "vertical",
        startValue: laneWindow.startKey,
        endValue: laneWindow.endKey,
        filterMode: "weakFilter",
        zoomLock: true,
        right: 4,
        top: playerTimelineAxisHeight + 4,
        bottom: 4,
        width: 8,
        showDataShadow: false,
        showDetail: false,
        brushSelect: false,
        borderColor: "transparent",
        backgroundColor: "transparent",
        fillerColor: palette.border,
        handleSize: 0,
        moveHandleSize: 0
      }
    );
  }

  return {
    animation: false,
    aria: {
      enabled: true,
      description: `Player session timeline. Online now: ${onlineCount}. Played in this time range: ${offlineCount}. ${visibleDescriptions.join(". ")}`
    },
    textStyle: { fontFamily: palette.fontFamily },
    grid: { id: "player-timeline-grid", left: gridLeft, right: 24, top: playerTimelineAxisHeight, bottom: 0, containLabel: false },
    xAxis: buildTimelineTimeAxisOption({
      id: "player-timeline-time-axis",
      query,
      viewport,
      palette,
      formatTime: effectiveFormatTime,
      formatShortTime,
      position: "top"
    }),
    yAxis: {
      id: "player-timeline-row-axis",
      type: "category",
      inverse: true,
      data: lanes.map((lane) => lane.key),
      show: false,
      axisTick: { show: false },
      axisLine: { show: false },
      splitLine: { show: false }
    },
    dataZoom,
    series: [
      {
        id: "player-row-chrome",
        name: "Player rows",
        type: "custom",
        coordinateSystem: "cartesian2d",
        renderItem: rowChromeRenderItem(lanes, query, palette, playerHeadSource),
        dimensions: ["start", "end", "lane", "laneIndex"],
        encode: { x: [0, 1], y: 2 },
        data: lanes.map((lane, index) => [query.from, query.to, lane.key, index]),
        silent: true,
        animation: false,
        clip: false,
        z: 1
      },
      {
        id: "player-sessions",
        name: "Player sessions",
        type: "custom",
        coordinateSystem: "cartesian2d",
        renderItem: sessionRenderItem(items, palette),
        dimensions: ["start", "end", "lane", "itemIndex"],
        encode: { x: [0, 1], y: 2 },
        data: items.map((item, index) => ({ name: item.accessibleLabel, value: [item.startedAt, item.endedAt, item.laneKey, index] })),
        silent: true,
        animation: false,
        clip: true,
        z: 2
      },
      ...(nowVisible && visibleLaneKeys.size ? [{
        id: "player-now-guide",
        name: "Current time",
        type: "custom" as const,
        coordinateSystem: "cartesian2d",
        renderItem: nowGuideRenderItem(now, palette),
        encode: { x: 0 },
        data: [[now]],
        silent: true,
        animation: false,
        clip: true,
        z: 3
      }] : [])
    ]
  };
}
