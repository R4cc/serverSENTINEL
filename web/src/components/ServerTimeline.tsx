import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ScheduleNavigationTarget,
  ServerTimelineEvent,
  ServerTimelinePlayerActivity,
  ServerTimelinePlayerSession,
  ServerTimelineResourcePoint,
  ServerTimelineResponse,
  ServerTimelineScheduleMarker
} from "../types";
import { groupNearbyRepeatedEvents } from "../utils/serverEvents";
import { EChartsCanvas, type TimelineDataZoomEvent } from "./EChartsCanvas";
import { EventIcon, ScheduleEventIcon } from "./EventIcon";
import {
  buildPlayerTimelineChartOption,
  formatTimelineDuration,
  playerTimelineChartHeight,
  playerTimelineHasLaneOverflow,
  playerTimelineLanePositionFromZoom,
  playerTimelineLanes,
  playerTimelineLaneWindowSize,
  preservePlayerTimelineLanePosition,
  resolvePlayerTimelineLaneWindow,
  type PlayerTimelineLanePosition,
  type PlayerTimelineRow
} from "./playerTimelineChart";
import { RuntimeControlIcon } from "./RuntimeControls";
import { subscribeToPageReactivation } from "../app/pageReactivation";
import {
  buildTimelineChartOption,
  clampTimelineWindow,
  dataZoomWindow,
  defaultTimelinePalette,
  liveTimelineWindow,
  timelineChartGrid,
  timelineMetricBandGrid,
  timelineHoverTooltipHtml,
  timelineNeedsRefill,
  timelineQueryWindow,
  timelineRetentionMs,
  type TimelinePalette
} from "./serverTimelineChart";
import { Banner, Button, HelpTooltip, LoadingLabel, PanelHeader } from "./UiPrimitives";
import { playerHeadSource, playerHeadVersion } from "../utils/playerHeads";

const timelineRanges = [
  { label: "5m", milliseconds: 5 * 60 * 1000 },
  { label: "15m", milliseconds: 15 * 60 * 1000 },
  { label: "1h", milliseconds: 60 * 60 * 1000 },
  { label: "3h", milliseconds: 3 * 60 * 60 * 1000 },
  { label: "6h", milliseconds: 6 * 60 * 60 * 1000 },
  { label: "24h", milliseconds: 24 * 60 * 60 * 1000 },
  { label: "7d", milliseconds: 7 * 24 * 60 * 60 * 1000 }
] as const;

type TimelineRange = typeof timelineRanges[number]["label"];
type TimelineSelection = TimelineRange | "custom";
const defaultTimelineRange: TimelineRange = "3h";
export type SeriesKey = "cpuUtilizationPercent" | "memoryUsageBytes" | "networkRxBytesPerSecond" | "networkTxBytesPerSecond" | "playersOnline";
export type TimelineWindow = { from: number; to: number };
type LoadTimeline = (from: number, to: number, maxPoints: number) => Promise<ServerTimelineResponse>;

export function timelineHorizontalWheelPixels(event: Pick<WheelEvent, "deltaMode" | "deltaX" | "deltaY" | "shiftKey">, pageWidth: number) {
  const horizontal = Math.abs(event.deltaX) >= Math.abs(event.deltaY) && event.deltaX !== 0
    ? event.deltaX
    : event.shiftKey
      ? event.deltaY
      : 0;
  if (!Number.isFinite(horizontal) || horizontal === 0) return 0;
  const unit = event.deltaMode === 1
    ? 16
    : event.deltaMode === 2
      ? pageWidth
      : 1;
  return horizontal * unit;
}

export function panTimelineWindowByPixels(viewport: TimelineWindow, deltaPixels: number, plotWidth: number, now = Date.now()): TimelineWindow {
  if (!Number.isFinite(deltaPixels) || !Number.isFinite(plotWidth) || plotWidth <= 0) return viewport;
  const deltaMs = deltaPixels / plotWidth * (viewport.to - viewport.from);
  return clampTimelineWindow({ from: viewport.from + deltaMs, to: viewport.to + deltaMs }, now);
}

type MetricBand = {
  key: "cpu" | "memory" | "network" | "players";
  label: string;
  series: SeriesKey[];
  prominent: boolean;
};

type TimelinePlayerRow = PlayerTimelineRow;

type TimelineMarker = {
  id: string;
  occurredAt: number;
  label: string;
  tone: "server" | "automation";
  event?: ServerTimelineEvent;
  occurrences?: number;
  restart?: {
    durationSeconds: number;
    events: [ServerTimelineEvent, ServerTimelineEvent];
  };
  schedule?: ServerTimelineScheduleMarker;
};

type TimelineActiveScheduleRange = {
  marker: TimelineMarker;
  leftPercent: number;
  widthPercent: number;
  clippedStart: boolean;
  clippedEnd: boolean;
  align: "start" | "center" | "end";
  durationLabel: string;
  statusLabel: string;
  accessibleLabel: string;
};

const visibleActiveScheduleLimit = 4;
const activeScheduleRowHeight = 32;
const activeScheduleRowGap = 6;

export function timelineActiveScheduleRanges(
  markers: TimelineMarker[],
  from: number,
  to: number,
  now = Date.now()
): TimelineActiveScheduleRange[] {
  const span = to - from;
  if (!Number.isFinite(span) || span <= 0) return [];
  const visibleEnd = Math.min(now, to);
  if (visibleEnd < from) return [];

  return markers
    .filter((marker) => marker.schedule?.kind === "active" && marker.occurredAt <= visibleEnd)
    .sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id))
    .map((marker) => {
      const clippedStart = marker.occurredAt < from;
      const clippedEnd = now > to;
      const start = Math.max(from, marker.occurredAt);
      const leftPercent = (start - from) / span * 100;
      const widthPercent = Math.max(0.25, (visibleEnd - start) / span * 100);
      const rightPercent = leftPercent + widthPercent;
      const durationLabel = formatTimelineDuration(Math.max(0, now - marker.occurredAt));
      const statusLabel = marker.schedule?.message?.trim() || "Running";
      const align = leftPercent < 16 ? "start" as const : rightPercent > 84 ? "end" as const : "center" as const;
      return {
        marker,
        leftPercent,
        widthPercent,
        clippedStart,
        clippedEnd,
        align,
        durationLabel,
        statusLabel,
        accessibleLabel: `${marker.schedule!.scheduleName}: ${statusLabel}; running for ${durationLabel}; still running`
      };
    });
}

export function TimelineAnnotationPopoverItem({
  marker,
  formatDate,
  onOpenSchedule
}: {
  marker: TimelineMarker;
  formatDate: (value: string | number | Date) => string;
  onOpenSchedule: (marker: TimelineMarker) => void;
}) {
  const content = (
    <>
      <span className="serverTimelineAnnotationPopoverGlyph" aria-hidden="true">
        {timelineMarkerGlyph(marker)}
        {marker.occurrences && marker.occurrences > 1 && <span className="timelineAnnotationOccurrenceBadge">×{marker.occurrences}</span>}
      </span>
      <span className="serverTimelineAnnotationPopoverItemBody">
        <strong>{marker.label}</strong>
        {marker.occurrences && marker.occurrences > 1 && <span className="srOnly">{marker.occurrences} occurrences</span>}
        {marker.schedule && <small>Open Schedules</small>}
      </span>
      <time className="serverTimelineAnnotationPopoverTimestamp" dateTime={new Date(marker.occurredAt).toISOString()}>
        {formatDate(marker.occurredAt)}
      </time>
    </>
  );

  if (marker.schedule) {
    return (
      <button
        type="button"
        className={`serverTimelineAnnotationPopoverItem is-interactive tone-${marker.tone}`}
        onClick={() => onOpenSchedule(marker)}
      >
        {content}
      </button>
    );
  }

  return <div className={`serverTimelineAnnotationPopoverItem tone-${marker.tone}`}>{content}</div>;
}

type AnnotationKey = "player" | "server" | "automation";

type TimelineHoverTooltip = {
  x: number;
  y: number;
  timestamp: number;
  html: string;
  alignEnd: boolean;
  pinned: boolean;
};

export type MarkerCluster = {
  id: string;
  occurredAt: number;
  markers: TimelineMarker[];
  tone: TimelineMarker["tone"];
  slot: number;
  slotCount: number;
};

const seriesOptions: Array<{ key: SeriesKey; label: string }> = [
  { key: "cpuUtilizationPercent", label: "CPU" },
  { key: "memoryUsageBytes", label: "Memory" },
  { key: "networkRxBytesPerSecond", label: "Network In" },
  { key: "networkTxBytesPerSecond", label: "Network Out" },
  { key: "playersOnline", label: "Players" }
];

const timelineMetricLayersStorageKey = "serversentinel-timeline-metric-layers";
const defaultTimelineMetricLayers: Record<SeriesKey, boolean> = {
  cpuUtilizationPercent: true,
  memoryUsageBytes: true,
  networkRxBytesPerSecond: false,
  networkTxBytesPerSecond: false,
  playersOnline: false
};

type TimelineMetricLayersStorage = Pick<Storage, "getItem" | "setItem">;

export function readTimelineMetricLayers(storage?: Pick<TimelineMetricLayersStorage, "getItem">): Record<SeriesKey, boolean> {
  try {
    const source = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    const saved = source?.getItem(timelineMetricLayersStorageKey);
    if (!saved) return { ...defaultTimelineMetricLayers };
    const parsed: unknown = JSON.parse(saved);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { ...defaultTimelineMetricLayers };
    return Object.fromEntries(seriesOptions.map(({ key }) => [
      key,
      typeof (parsed as Record<string, unknown>)[key] === "boolean"
        ? (parsed as Record<string, boolean>)[key]
        : defaultTimelineMetricLayers[key]
    ])) as Record<SeriesKey, boolean>;
  } catch {
    return { ...defaultTimelineMetricLayers };
  }
}

export function writeTimelineMetricLayers(
  enabled: Record<SeriesKey, boolean>,
  storage?: Pick<TimelineMetricLayersStorage, "setItem">
) {
  try {
    const target = storage ?? (typeof window === "undefined" ? undefined : window.localStorage);
    target?.setItem(timelineMetricLayersStorageKey, JSON.stringify(enabled));
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
}

const annotationOptions: Array<{ key: AnnotationKey; label: string }> = [
  { key: "player", label: "Player activity" },
  { key: "server", label: "Server events" },
  { key: "automation", label: "Automation runs" }
];

function fallbackPlayerActivity(data: ServerTimelineResponse): ServerTimelinePlayerActivity {
  const sessions: ServerTimelinePlayerSession[] = [];
  const open = new Map<string, { player: string; startedAt: number }>();
  for (const event of [...data.events].sort((left, right) => left.occurredAt - right.occurredAt)) {
    if (event.eventType !== "player_joined" && event.eventType !== "player_left") continue;
    const player = event.subject?.trim();
    if (!player) continue;
    const key = player.toLocaleLowerCase();
    if (event.eventType === "player_joined") {
      if (!open.has(key)) open.set(key, { player, startedAt: event.occurredAt });
      continue;
    }
    const active = open.get(key);
    if (!active) continue;
    sessions.push({
      id: `fallback:${key}:${active.startedAt}`,
      player: active.player,
      startedAt: active.startedAt,
      endedAt: event.occurredAt,
      startBoundary: "join",
      endBoundary: "leave"
    });
    open.delete(key);
  }
  for (const [key, active] of open) {
    sessions.push({
      id: `fallback:${key}:${active.startedAt}`,
      player: active.player,
      startedAt: active.startedAt,
      endedAt: data.to,
      startBoundary: "join",
      endBoundary: "history-boundary"
    });
  }
  return { snapshotState: "unavailable", onlineNames: [], sessions };
}

export function timelinePlayerRows(data: ServerTimelineResponse | null, viewport: TimelineWindow, now: number): TimelinePlayerRow[] {
  if (!data) return [];
  const activity = data.playerActivity ?? fallbackPlayerActivity(data);
  const online = new Map(activity.onlineNames.map((player) => [player.toLocaleLowerCase(), player]));
  const includesNow = now >= viewport.from && now <= viewport.to;
  const rows = new Map<string, TimelinePlayerRow>();
  if (includesNow) {
    for (const player of activity.onlineNames) rows.set(player.toLocaleLowerCase(), { player, online: true, sessions: [] });
  }
  for (const session of activity.sessions) {
    const sessionEnd = session.endedAt ?? now;
    if (session.startedAt > viewport.to || sessionEnd < viewport.from) continue;
    const key = session.player.toLocaleLowerCase();
    const row = rows.get(key) ?? { player: online.get(key) ?? session.player, online: online.has(key), sessions: [] };
    row.sessions.push(session);
    rows.set(key, row);
  }
  return [...rows.values()]
    .map((row) => ({ ...row, sessions: row.sessions.sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id)) }))
    .sort((left, right) => Number(right.online) - Number(left.online) || left.player.localeCompare(right.player, undefined, { sensitivity: "base" }));
}

const timelineLifecycleEventTypes = new Set<ServerTimelineEvent["eventType"]>([
  "server_started",
  "server_stopped",
  "server_crashed"
]);
const timelineRestartWindowMs = 5 * 60_000;

export function timelineMarkers(data: ServerTimelineResponse | null): TimelineMarker[] {
  if (!data) return [];
  const eventMarkers: TimelineMarker[] = [];
  const events = data.events
    .filter((event) => timelineLifecycleEventTypes.has(event.eventType))
    .sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
  const repeatedGroups = groupNearbyRepeatedEvents(events, (event) => event.occurredAt);
  for (let index = 0; index < repeatedGroups.length; index += 1) {
    const repeated = repeatedGroups[index];
    const event = repeated.at(-1)!;
    const nextGroup = repeatedGroups[index + 1];
    const next = nextGroup?.at(-1);
    const restartDuration = next ? next.occurredAt - event.occurredAt : Number.POSITIVE_INFINITY;
    if (
      event.eventType === "server_stopped"
      && next?.eventType === "server_started"
      && restartDuration >= 0
      && restartDuration <= timelineRestartWindowMs
    ) {
      eventMarkers.push({
        id: `restart:${repeated.map((item) => item.id).join(":")}:${nextGroup!.map((item) => item.id).join(":")}`,
        occurredAt: next.occurredAt,
        label: "Server restarted",
        tone: "server",
        event: next,
        restart: {
          durationSeconds: Math.round(restartDuration / 1_000),
          events: [event, next]
        }
      });
      index += 1;
      continue;
    }
    if (repeated.length > 1) {
      eventMarkers.push({
        id: `repeated:${repeated.map((item) => item.id).join(":")}`,
        occurredAt: event.occurredAt,
        label: event.message,
        tone: "server",
        event,
        occurrences: repeated.length
      });
      continue;
    }
    eventMarkers.push({
      id: `event:${event.id}`,
      occurredAt: event.occurredAt,
      label: event.message,
      tone: "server",
      event
    });
  }
  return [
    ...eventMarkers,
    ...data.schedules.map((schedule) => ({
      id: schedule.id,
      occurredAt: schedule.occurredAt,
      label: `${schedule.scheduleName}: ${schedule.status}`,
      tone: "automation" as const,
      schedule
    }))
  ].sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
}

export function clusterTimelineMarkers(markers: TimelineMarker[], from: number, to: number, slots = 24): MarkerCluster[] {
  if (!markers.length || to <= from) return [];
  const bucketMs = Math.max(1, (to - from) / slots);
  const visible = markers
    .filter((marker) => marker.occurredAt >= from && marker.occurredAt <= to)
    .sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
  const groups: TimelineMarker[][] = [];
  for (const marker of visible) {
    const current = groups.at(-1);
    const first = current?.[0];
    if (!current || !first || marker.occurredAt - first.occurredAt >= bucketMs) groups.push([marker]);
    else current.push(marker);
  }
  return groups.map((grouped) => {
    const occurredAt = Math.round(grouped.reduce((total, marker) => total + marker.occurredAt, 0) / grouped.length);
    return {
      id: `cluster:${grouped.map((marker) => marker.id).join(":")}`,
      occurredAt,
      markers: grouped,
      tone: grouped.length === 1
        ? grouped[0].tone
        : grouped.some((marker) => marker.tone === "server")
          ? "server"
          : grouped.some((marker) => marker.tone === "automation")
            ? "automation"
            : grouped[0].tone,
      slot: Math.max(0, Math.min(slots - 1, Math.floor((occurredAt - from) / bucketMs))),
      slotCount: slots
    };
  });
}

type PositionedMarkerCluster = MarkerCluster & {
  leftPercent: number;
  lane: number;
  alignEnd: boolean;
  inlineLabel: string | null;
  labelTop: number;
  labelHeight: number;
};

type TimelineMarkerDisplayLabel = {
  primary: string;
  secondary?: string;
};

function capitalizeTimelineLabel(value: string) {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

export function timelineMarkerDisplayLabel(marker: TimelineMarker): TimelineMarkerDisplayLabel {
  if (marker.restart) return { primary: "Server restarted" };
  const event = marker.event;
  if (event?.eventType === "server_started") return { primary: "Server started" };
  if (event?.eventType === "server_stopped") return { primary: "Server stopped" };
  if (event?.eventType === "server_crashed") return { primary: "Server crashed" };
  if (event?.eventType === "server_overloaded") return { primary: "Server overloaded" };
  if (event?.eventType === "exception_caught") return { primary: "Exception caught", secondary: event.subject };
  if (event?.eventType === "mod_disabled") return { primary: "Mod disabled", secondary: event.subject };
  if (marker.schedule) return {
    primary: marker.schedule.scheduleName,
    secondary: capitalizeTimelineLabel(marker.schedule.status)
  };
  return { primary: marker.label };
}

const maxTimelineClusterIcons = 3;

export function timelineClusterIconMarkers(cluster: MarkerCluster) {
  const icons: TimelineMarker[] = [];
  for (const marker of cluster.markers) {
    for (let index = 0; index < (marker.occurrences ?? 1) && icons.length < maxTimelineClusterIcons; index += 1) icons.push(marker);
    if (icons.length === maxTimelineClusterIcons) break;
  }
  return icons;
}

export function positionTimelineClusters(clusters: MarkerCluster[], from: number, to: number, railWidth = 1_000): PositionedMarkerCluster[] {
  if (to <= from) return [];
  const availableWidth = Math.max(1, railWidth);
  const measurements = clusters.map((cluster) => {
    const leftPercent = Math.max(0, Math.min(100, (cluster.occurredAt - from) / (to - from) * 100));
    const center = availableWidth * leftPercent / 100;
    const occurrenceCount = cluster.markers.reduce((total, marker) => total + (marker.occurrences ?? 1), 0);
    const iconCount = timelineClusterIconMarkers(cluster).length;
    const compactWidth = occurrenceCount > 1 ? 58 + String(occurrenceCount).length * 6 + Math.max(0, iconCount - 1) * 9 : 28;
    const alignEnd = center + compactWidth - 14 > availableWidth;
    return {
      cluster,
      leftPercent,
      center,
      compactWidth,
      compactLeft: alignEnd ? center - compactWidth + 14 : center - 14,
      alignEnd,
      inlineLabel: occurrenceCount === 1 && cluster.markers.length === 1
        ? timelineMarkerDisplayLabel(cluster.markers[0]).primary
        : null
    };
  });
  return measurements.map((measurement, index) => {
    const next = measurements[index + 1];
    const inlineWidth = measurement.inlineLabel ? 38 + measurement.inlineLabel.length * 6.2 : 0;
    const rightLimit = next ? next.compactLeft - 10 : availableWidth;
    const showInlineLabel = Boolean(measurement.inlineLabel && measurement.center - 14 + inlineWidth <= rightLimit);
    return {
      ...measurement.cluster,
      leftPercent: measurement.leftPercent,
      lane: 0,
      alignEnd: showInlineLabel ? false : measurement.alignEnd,
      inlineLabel: showInlineLabel ? measurement.inlineLabel : null,
      labelTop: 9,
      labelHeight: 30
    };
  });
}

export function timelineAnnotationGridTop(_clusters: PositionedMarkerCluster[]) {
  return timelineChartGrid.top;
}

/**
 * A pointer press dismisses the event popover unless it lands inside the popover itself or on a
 * cluster marker, whose own click handler owns opening, switching, and toggling the selection.
 */
export function annotationPopoverDismissedByPointer(target: EventTarget | null, popover: Pick<Element, "contains"> | null) {
  const element = target as Element | null;
  if (!element || typeof element.closest !== "function") return true;
  if (popover?.contains(element)) return false;
  return !element.closest(".timelineAnnotationCluster");
}

function uniqueBy<T>(items: T[], key: (item: T) => string | number) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function timelineEventIdentity(event: ServerTimelineEvent) {
  return [event.source, event.occurredAt, event.signature, event.message, event.details ?? ""].join("\u0000");
}

export function mergeTimelineResponses(current: ServerTimelineResponse, incoming: ServerTimelineResponse, from: number, to: number): ServerTimelineResponse {
  const incomingOnlinePlayers = new Set(
    incoming.playerActivity?.onlineNames.map((player) => player.trim().toLocaleLowerCase()) ?? []
  );
  const incomingActivityPlayers = new Set([
    ...incomingOnlinePlayers,
    ...(incoming.playerActivity?.sessions.map((session) => session.player.trim().toLocaleLowerCase()) ?? [])
  ]);
  const playerActivity = incoming.playerActivity || current.playerActivity
    ? {
        ...(current.playerActivity ?? { snapshotState: "unavailable" as const, onlineNames: [], sessions: [] }),
        ...(incoming.playerActivity ?? {}),
        sessions: uniqueBy([
          ...(incoming.playerActivity?.sessions ?? []),
          ...(current.playerActivity?.sessions ?? []).filter((session) => {
            if (!incoming.playerActivity) return true;
            const key = session.player.trim().toLocaleLowerCase();
            if (session.endedAt === null && !incomingOnlinePlayers.has(key)) return false;
            const overlapsIncoming = session.startedAt <= incoming.to
              && (session.endedAt ?? Number.POSITIVE_INFINITY) >= incoming.from;
            if (incomingActivityPlayers.has(key) && overlapsIncoming) return false;
            return !incoming.playerActivity.sessions.some((candidate) => candidate.id === session.id);
          })
        ], (session) => session.id)
          .filter((session) => session.startedAt <= to && (session.endedAt ?? Number.POSITIVE_INFINITY) >= from)
          .sort((left, right) => left.startedAt - right.startedAt || left.id.localeCompare(right.id))
      }
    : undefined;
  return {
    ...incoming,
    from,
    to,
    latest: incoming.latest ?? current.latest,
    samples: uniqueBy([...current.samples, ...incoming.samples], (point) => point.sampledAt)
      .filter((point) => point.sampledAt >= from && point.sampledAt <= to)
      .sort((left, right) => left.sampledAt - right.sampledAt),
    events: uniqueBy([...current.events, ...incoming.events], timelineEventIdentity)
      .filter((event) => event.occurredAt >= from && event.occurredAt <= to)
      .sort((left, right) => left.occurredAt - right.occurredAt),
    schedules: incoming.scheduleAnnotationsAvailable
      ? uniqueBy([...current.schedules, ...incoming.schedules], (marker) => marker.id)
          .filter((marker) => marker.occurredAt >= from && marker.occurredAt <= to)
          .sort((left, right) => left.occurredAt - right.occurredAt)
      : [],
    playerActivity,
    truncated: { schedules: current.truncated.schedules || incoming.truncated.schedules }
  };
}

function markerTitle(cluster: MarkerCluster, formatDate: (value: string | number | Date) => string) {
  return cluster.markers.map((marker) => `${formatDate(marker.occurredAt)} — ${marker.label}${marker.occurrences && marker.occurrences > 1 ? ` (×${marker.occurrences})` : ""}`).join("\n");
}

export function timelineClusterOccurrenceCount(cluster: MarkerCluster) {
  return cluster.markers.reduce((total, marker) => total + (marker.occurrences ?? 1), 0);
}

export function timelineMarkerGlyph(marker: TimelineMarker) {
  if (marker.restart) return <RuntimeControlIcon action="restart" />;
  if (marker.event?.eventType === "server_started") return <RuntimeControlIcon action="start" />;
  if (marker.event?.eventType === "server_stopped") return <RuntimeControlIcon action="stop" />;
  if (marker.event) return <EventIcon kind={marker.event.eventType} />;
  if (marker.schedule) return <ScheduleEventIcon />;
  return null;
}

function readTimelinePalette(element: HTMLElement): TimelinePalette {
  const styles = getComputedStyle(element);
  const read = (property: string, fallback: string) => styles.getPropertyValue(property).trim() || fallback;
  return {
    cpu: read("--timeline-cpu", defaultTimelinePalette.cpu),
    memory: read("--timeline-memory", defaultTimelinePalette.memory),
    networkIn: read("--timeline-network-in", defaultTimelinePalette.networkIn),
    networkOut: read("--timeline-network-out", defaultTimelinePalette.networkOut),
    players: read("--timeline-players", defaultTimelinePalette.players),
    join: read("--timeline-join", defaultTimelinePalette.join),
    leave: read("--timeline-leave", defaultTimelinePalette.leave),
    server: read("--timeline-server", defaultTimelinePalette.server),
    automation: read("--timeline-schedule", defaultTimelinePalette.automation),
    accent: read("--accent", defaultTimelinePalette.accent),
    text: read("--text", defaultTimelinePalette.text),
    textMuted: read("--text-muted", defaultTimelinePalette.textMuted),
    // --border-subtle is a width token; charts need the color, or ECharts silently
    // falls back to its own defaults for row rules and the vertical scrollbar.
    border: read("--border-muted", defaultTimelinePalette.border),
    surface: read("--surface-raised", defaultTimelinePalette.surface),
    fontFamily: read("--font-sans", defaultTimelinePalette.fontFamily)
  };
}

function useTimelinePresentation(panelRef: React.RefObject<HTMLElement | null>) {
  const [palette, setPalette] = useState(defaultTimelinePalette);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const update = () => {
      const next = readTimelinePalette(panel);
      setPalette((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    // Only the theme classes move these colours. Watching `style` as well meant every write of
    // --visual-viewport-height on :root — one per visual-viewport scroll frame on mobile — ran a
    // full palette read plus two JSON.stringify calls for the equality check below.
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const shell = panel.closest(".appShell");
    if (shell) observer.observe(shell, { attributes: true, attributeFilter: ["class"] });
    update();
    return () => observer.disconnect();
  }, [panelRef]);

  return palette;
}

function PlayerSessionSection({
  rows,
  query,
  viewport,
  now,
  palette,
  formatTime,
  formatShortTime,
  gridLeft,
  playerHeadSourceFor,
  interacting,
  onDataZoom,
  onInteractionChange,
  onPointerEnter,
  onWheel
}: {
  rows: TimelinePlayerRow[];
  query: TimelineWindow;
  viewport: TimelineWindow;
  now: number;
  palette: TimelinePalette;
  formatTime: (value: string | number | Date) => string;
  formatShortTime: (value: string | number | Date) => string;
  gridLeft: number;
  playerHeadSourceFor?: (player: string) => string;
  interacting: boolean;
  onDataZoom: (event: TimelineDataZoomEvent) => void;
  onInteractionChange: (interacting: boolean) => void;
  onPointerEnter: React.PointerEventHandler<HTMLElement>;
  onWheel: (event: globalThis.WheelEvent) => boolean;
}) {
  const stableRowsRef = useRef(rows);
  if (!interacting) stableRowsRef.current = rows;
  const displayRows = interacting ? stableRowsRef.current : rows;
  const lanes = useMemo(() => playerTimelineLanes(displayRows), [displayRows]);
  const [expanded, setExpanded] = useState(false);
  const laneWindowSize = playerTimelineLaneWindowSize(lanes.length, expanded);
  const collapsedOverflow = playerTimelineHasLaneOverflow(lanes.length);
  const [verticalPosition, setVerticalPosition] = useState<PlayerTimelineLanePosition>({ startIndex: 0 });
  const previousLanesRef = useRef(lanes);
  const anchoredPosition = preservePlayerTimelineLanePosition(previousLanesRef.current, lanes, verticalPosition, laneWindowSize);
  const resolvedPosition = resolvePlayerTimelineLaneWindow(lanes, anchoredPosition, laneWindowSize);
  const onlineCount = displayRows.filter((row) => row.online).length;
  const offlineCount = displayRows.length - onlineCount;
  useEffect(() => {
    previousLanesRef.current = lanes;
    setVerticalPosition((current) =>
      current.startKey === anchoredPosition.startKey && current.startIndex === anchoredPosition.startIndex
        ? current
        : anchoredPosition
    );
  }, [anchoredPosition.startIndex, anchoredPosition.startKey, lanes]);
  const option = useMemo(() => buildPlayerTimelineChartOption({
    rows: displayRows,
    lanes,
    query,
    viewport,
    verticalPosition: resolvedPosition,
    visibleLaneCount: laneWindowSize,
    now,
    palette,
    formatTime,
    formatShortTime,
    gridLeft,
    playerHeadSource: playerHeadSourceFor
  }), [displayRows, formatShortTime, formatTime, gridLeft, laneWindowSize, lanes, now, palette, playerHeadSourceFor, query, resolvedPosition.endKey, resolvedPosition.startIndex, resolvedPosition.startKey, viewport]);
  const handleDataZoom = useCallback((event: TimelineDataZoomEvent) => {
    const nextPosition = playerTimelineLanePositionFromZoom(event, lanes);
    if (nextPosition) setVerticalPosition(nextPosition);
    onDataZoom(event);
  }, [lanes, onDataZoom]);

  return (
    <section
      className="serverTimelinePlayers"
      aria-label="Player sessions"
      data-viewport-from={viewport.from}
      data-viewport-to={viewport.to}
      onPointerEnter={onPointerEnter}
    >
      <header className="serverTimelinePlayerHeader">
        <div className="serverTimelinePlayerHeading">
          <strong>Player activity</strong>
          <span className="serverTimelinePlayerCounts">
            {onlineCount > 0 && <span className="serverTimelinePlayerCount tone-online"><i aria-hidden="true" />{onlineCount} online</span>}
            {offlineCount > 0 && <span className="serverTimelinePlayerCount tone-offline"><i aria-hidden="true" />{offlineCount} earlier</span>}
          </span>
        </div>
        {collapsedOverflow && (
          <Button
            variant="ghost"
            compact
            className="serverTimelinePlayerToggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? "Show fewer" : "Show more players"}
            <span className="serverTimelinePlayerToggleGlyph" aria-hidden="true">{expanded ? "▴" : "▾"}</span>
          </Button>
        )}
      </header>
      {lanes.length ? (
        <>
          <div
            className={`serverTimelinePlayerChart${expanded ? " is-expanded" : ""}`}
            style={{ height: playerTimelineChartHeight(lanes.length, expanded) }}
          >
            <EChartsCanvas
              option={option}
              onDataZoom={handleDataZoom}
              onInteractionChange={onInteractionChange}
              onWheel={onWheel}
            />
          </div>
        </>
      ) : (
        <div
          className="serverTimelinePlayerChart serverTimelinePlayerEmpty"
          style={{ height: playerTimelineChartHeight(0) }}
        >
          No player activity in this time range.
        </div>
      )}
    </section>
  );
}

export function zoomTimelineWindowAtPixel(
  viewport: TimelineWindow,
  deltaPixels: number,
  anchorPixel: number,
  plotWidth: number,
  now = Date.now()
): TimelineWindow {
  if (plotWidth <= 0 || !Number.isFinite(deltaPixels)) return viewport;
  const span = Math.max(1, viewport.to - viewport.from);
  const nextSpan = Math.min(timelineRetentionMs, Math.max(60_000, span * Math.exp(deltaPixels * 0.0015)));
  const anchorRatio = Math.min(1, Math.max(0, anchorPixel / plotWidth));
  const anchorTime = viewport.from + span * anchorRatio;
  return clampTimelineWindow({
    from: anchorTime - nextSpan * anchorRatio,
    to: anchorTime + nextSpan * (1 - anchorRatio)
  }, now);
}

export function ServerTimeline({
  loadTimeline,
  formatTime,
  formatShortTime,
  formatDate,
  onLatestSample,
  onOpenSchedules,
  serverId = "",
  playerHeadsEnabled = false,
  paused = false
}: {
  loadTimeline: LoadTimeline;
  formatTime: (value: string | number | Date) => string;
  formatShortTime: (value: string | number | Date) => string;
  formatDate: (value: string | number | Date) => string;
  onLatestSample?: (sample?: ServerTimelineResourcePoint) => void;
  onOpenSchedules: (target?: ScheduleNavigationTarget) => void;
  serverId?: string;
  playerHeadsEnabled?: boolean;
  /** Set while the overview is off screen: the timeline stays mounted but stops following live. */
  paused?: boolean;
}) {
  const initialSpan = timelineRanges.find((range) => range.label === defaultTimelineRange)!.milliseconds;
  const [selection, setSelection] = useState<TimelineSelection>(defaultTimelineRange);
  const [lastPreset, setLastPreset] = useState<TimelineRange>(defaultTimelineRange);
  const [live, setLive] = useState(true);
  const [viewport, setViewportState] = useState<TimelineWindow>(() => liveTimelineWindow(initialSpan));
  const [data, setData] = useState<ServerTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [clockNow, setClockNow] = useState(Date.now());
  const [selectedCluster, setSelectedCluster] = useState<MarkerCluster | null>(null);
  const [annotationRailWidth, setAnnotationRailWidth] = useState(1_000);
  const [visualizationWidth, setVisualizationWidth] = useState(1_400);
  const [hoverTooltip, setHoverTooltip] = useState<TimelineHoverTooltip | null>(null);
  const [chartInteracting, setChartInteracting] = useState(false);
  const [enabled, setEnabled] = useState<Record<SeriesKey, boolean>>(() => readTimelineMetricLayers());
  const [annotationEnabled, setAnnotationEnabled] = useState<Record<AnnotationKey, boolean>>({
    player: true,
    server: true,
    automation: true
  });
  const panelRef = useRef<HTMLElement>(null);
  const visualizationRef = useRef<HTMLDivElement>(null);
  const annotationRailRef = useRef<HTMLDivElement>(null);
  const annotationPopoverRef = useRef<HTMLElement>(null);
  const viewportRef = useRef(viewport);
  const dataRef = useRef<ServerTimelineResponse | null>(null);
  const liveRef = useRef(live);
  const lastFullLoadRef = useRef(0);
  const requestIdRef = useRef(0);
  const navigationTimerRef = useRef<number | undefined>(undefined);
  const hoverFrameRef = useRef<number | undefined>(undefined);
  const palette = useTimelinePresentation(panelRef);
  const navigationPendingRef = useRef(false);
  const headVersion = playerHeadVersion(clockNow);
  const playerHeadSourceFor = useCallback(
    (player: string) => playerHeadSource(serverId, player, headVersion),
    [headVersion, serverId]
  );

  const toggleMetricLayer = useCallback((key: SeriesKey) => {
    setEnabled((current) => {
      const next = { ...current, [key]: !current[key] };
      writeTimelineMetricLayers(next);
      return next;
    });
  }, []);

  const setViewport = useCallback((next: TimelineWindow) => {
    const bounded = clampTimelineWindow(next);
    viewportRef.current = bounded;
    setViewportState(bounded);
  }, []);

  const setLiveMode = useCallback((next: boolean) => {
    liveRef.current = next;
    setLive(next);
  }, []);

  const loadWindow = useCallback(async (nextViewport: TimelineWindow, nextLive: boolean, options: {
    showLoading?: boolean;
    incremental?: boolean;
    commitViewport?: boolean;
    onCommit?: () => void;
  } = {}) => {
    const now = Date.now();
    const boundedViewport = clampTimelineWindow(nextViewport, now);
    const query = timelineQueryWindow(boundedViewport, nextLive, now);
    const current = dataRef.current;
    const generatedAt = current ? new Date(current.generatedAt).getTime() : NaN;
    const incremental = Boolean(
      options.incremental
      && current
      && Number.isFinite(generatedAt)
      && now - lastFullLoadRef.current < 60_000
      && current.to >= query.from
      && current.to <= query.to
    );
    const requestFrom = incremental ? Math.max(query.from, generatedAt - 15_000) : query.from;
    const requestId = ++requestIdRef.current;
    if (options.showLoading) setLoading(true);
    try {
      const response = await loadTimeline(requestFrom, query.to, 1_200);
      if (requestId !== requestIdRef.current) return;
      const next = incremental && current
        ? mergeTimelineResponses(current, response, query.from, query.to)
        : { ...response, from: query.from, to: query.to };
      if (!incremental) lastFullLoadRef.current = now;
      dataRef.current = next;
      if (options.commitViewport) setViewport(boundedViewport);
      setData(next);
      options.onCommit?.();
      onLatestSample?.(next.latest);
      setError("");
    } catch (requestError) {
      if (requestId === requestIdRef.current) setError((requestError as Error).message || "Timeline data is unavailable");
    } finally {
      if (requestId === requestIdRef.current) {
        if (options.commitViewport) navigationPendingRef.current = false;
        setLoading(false);
      }
    }
  }, [loadTimeline, onLatestSample, setViewport]);

  useEffect(() => {
    void loadWindow(viewportRef.current, true, { showLoading: true });
    return () => {
      requestIdRef.current += 1;
      if (navigationTimerRef.current !== undefined) window.clearTimeout(navigationTimerRef.current);
      onLatestSample?.(undefined);
    };
  }, [loadWindow, onLatestSample]);

  // `document.hidden` covers a backgrounded tab but not an overview that is merely off screen, and
  // the timeline now outlives the page that shows it. Following live output nobody can see would
  // trade the render this saves for a poll and a redraw every five seconds.
  useEffect(() => {
    if (!live || paused) return;
    const refreshLiveTimeline = () => {
      if (document.hidden || navigationPendingRef.current) return;
      const span = viewportRef.current.to - viewportRef.current.from;
      const next = liveTimelineWindow(span);
      setClockNow(Date.now());
      setViewport(next);
      void loadWindow(next, true, { incremental: true });
    };
    const interval = window.setInterval(refreshLiveTimeline, 5_000);
    const unsubscribe = subscribeToPageReactivation(refreshLiveTimeline);
    return () => {
      window.clearInterval(interval);
      unsubscribe();
    };
  }, [live, paused, loadWindow, setViewport]);

  // Coming back to a paused timeline should show current data, not the window it froze on.
  const wasPausedRef = useRef(paused);
  useEffect(() => {
    const resumed = wasPausedRef.current && !paused;
    wasPausedRef.current = paused;
    if (!resumed || !live) return;
    const span = viewportRef.current.to - viewportRef.current.from;
    const next = liveTimelineWindow(span);
    setClockNow(Date.now());
    setViewport(next);
    void loadWindow(next, true, { incremental: true });
  }, [paused, live, loadWindow, setViewport]);

  useEffect(() => {
    if (!selectedCluster && !hoverTooltip?.pinned) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelectedCluster(null);
        setHoverTooltip(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [hoverTooltip?.pinned, selectedCluster]);

  useEffect(() => {
    if (!selectedCluster) return;
    const closeOnOutsidePointer = (event: globalThis.PointerEvent) => {
      if (annotationPopoverDismissedByPointer(event.target, annotationPopoverRef.current)) setSelectedCluster(null);
    };
    window.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => window.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [selectedCluster]);

  // A hidden element measures zero. Keeping the last real width stops the whole chart being laid
  // out again for a size nobody is looking at, and then a second time on the way back.
  useEffect(() => {
    const rail = annotationRailRef.current;
    if (!rail) return;
    const updateWidth = () => {
      const width = rail.getBoundingClientRect().width;
      if (width > 0) setAnnotationRailWidth(width);
    };
    const observer = new ResizeObserver(updateWidth);
    observer.observe(rail);
    updateWidth();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = visualizationRef.current;
    if (!element) return;
    const updateWidth = () => {
      const width = element.getBoundingClientRect().width;
      if (width > 0) setVisualizationWidth(width);
    };
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    updateWidth();
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (hoverFrameRef.current !== undefined) window.cancelAnimationFrame(hoverFrameRef.current);
  }, []);

  const allMarkers = useMemo(() => timelineMarkers(data), [data]);
  const markers = useMemo(() => allMarkers.filter((marker) => marker.schedule?.kind !== "active" && annotationEnabled[marker.tone]), [allMarkers, annotationEnabled]);
  const activeScheduleRanges = useMemo(
    () => annotationEnabled.automation
      ? timelineActiveScheduleRanges(allMarkers, viewport.from, viewport.to, clockNow)
      : [],
    [allMarkers, annotationEnabled.automation, clockNow, viewport.from, viewport.to]
  );
  const visibleActiveScheduleRanges = activeScheduleRanges.slice(0, visibleActiveScheduleLimit);
  const clusters = useMemo(() => clusterTimelineMarkers(markers, viewport.from, viewport.to), [markers, viewport.from, viewport.to]);
  const positionedClusters = useMemo(
    () => positionTimelineClusters(clusters, viewport.from, viewport.to, annotationRailWidth),
    [annotationRailWidth, clusters, viewport.from, viewport.to]
  );
  const visibleEventCount = useMemo(
    () => activeScheduleRanges.length + clusters.reduce((total, cluster) => total + timelineClusterOccurrenceCount(cluster), 0),
    [activeScheduleRanges.length, clusters]
  );
  const nextAnnotationGridTop = useMemo(() => timelineAnnotationGridTop(positionedClusters), [positionedClusters]);
  // Panning changes annotation clusters continuously. Keep their reserved rail
  // height fixed until the gesture ends so the chart does not bounce vertically.
  const stableAnnotationGridTopRef = useRef(nextAnnotationGridTop);
  const baseAnnotationGridTop = chartInteracting ? stableAnnotationGridTopRef.current : nextAnnotationGridTop;
  const activeScheduleGridHeight = visibleActiveScheduleRanges.length
    ? activeScheduleRowGap + visibleActiveScheduleRanges.length * activeScheduleRowHeight
    : 0;
  const annotationGridTop = baseAnnotationGridTop + activeScheduleGridHeight;
  const selectedPosition = selectedCluster ? positionedClusters.find((cluster) => cluster.id === selectedCluster.id) : undefined;
  const query = useMemo<TimelineWindow>(() => data ? { from: data.from, to: data.to } : timelineQueryWindow(viewport, live), [data, live, viewport]);
  const labelGutter = Math.round(Math.max(180, Math.min(260, visualizationWidth * 0.17)));
  const metricGrid = useMemo(() => ({ ...timelineMetricBandGrid, left: labelGutter }), [labelGutter]);
  const sharedGuide = hoverTooltip
    ? { x: hoverTooltip.x, top: annotationGridTop, pinned: hoverTooltip.pinned, tone: undefined }
    : selectedCluster && selectedPosition
      ? {
          x: metricGrid.left + annotationRailWidth * selectedPosition.leftPercent / 100,
          top: annotationGridTop,
          pinned: true,
          tone: selectedCluster.tone
        }
      : undefined;
  const playerRows = useMemo(() => timelinePlayerRows(data, viewport, clockNow), [clockNow, data, viewport]);
  const metricBands = useMemo<MetricBand[]>(() => [
    ...(enabled.cpuUtilizationPercent ? [{ key: "cpu" as const, label: "CPU", series: ["cpuUtilizationPercent" as const], prominent: true }] : []),
    ...(enabled.memoryUsageBytes ? [{ key: "memory" as const, label: "Memory", series: ["memoryUsageBytes" as const], prominent: true }] : []),
    ...(enabled.networkRxBytesPerSecond || enabled.networkTxBytesPerSecond ? [{
      key: "network" as const,
      label: "Network",
      series: [
        ...(enabled.networkRxBytesPerSecond ? ["networkRxBytesPerSecond" as const] : []),
        ...(enabled.networkTxBytesPerSecond ? ["networkTxBytesPerSecond" as const] : [])
      ],
      prominent: false
    }] : []),
    ...(enabled.playersOnline ? [{ key: "players" as const, label: "Players", series: ["playersOnline" as const], prominent: false }] : [])
  ], [enabled]);
  const resourceState = useMemo(() => {
    if (!data?.samples.length) return "empty";
    const available = data.samples.filter((point) => point.available && point.running && (point.cpuUtilizationPercent !== null || point.memoryUsageBytes !== null)).length;
    if (available === 0) return "unavailable";
    return "available";
  }, [data]);

  const activateMarker = useCallback((marker: TimelineMarker) => {
    const schedule = marker.schedule;
    if (!schedule) return;
    if (schedule.kind === "run" && schedule.runId) onOpenSchedules({ kind: "completed-run", scheduleId: schedule.scheduleId, runId: schedule.runId });
    else if (schedule.kind === "active" && schedule.runId) onOpenSchedules({ kind: "active-run", scheduleId: schedule.scheduleId, runId: schedule.runId });
    else onOpenSchedules({ kind: "schedule", scheduleId: schedule.scheduleId });
  }, [onOpenSchedules]);

  const selectPreset = (range: TimelineRange, nextLive = liveRef.current) => {
    const span = timelineRanges.find((candidate) => candidate.label === range)?.milliseconds ?? initialSpan;
    const current = viewportRef.current;
    const center = (current.from + current.to) / 2;
    const historicalTo = Math.min(Date.now(), center + span / 2);
    const next = nextLive ? liveTimelineWindow(span) : { from: historicalTo - span, to: historicalTo };
    setSelectedCluster(null);
    setHoverTooltip(null);
    setClockNow(Date.now());
    navigationPendingRef.current = true;
    void loadWindow(next, nextLive, {
      showLoading: true,
      commitViewport: true,
      onCommit: () => {
        setSelection(range);
        setLastPreset(range);
        setLiveMode(nextLive);
      }
    });
  };

  const jumpToNow = () => selectPreset(lastPreset, true);

  const resetView = () => {
    const span = timelineRanges.find((candidate) => candidate.label === lastPreset)?.milliseconds ?? initialSpan;
    if (live) {
      selectPreset(lastPreset);
      return;
    }
    const current = viewportRef.current;
    const center = (current.from + current.to) / 2;
    const nextTo = Math.min(Date.now(), center + span / 2);
    const next = { from: nextTo - span, to: nextTo };
    setSelection(lastPreset);
    setSelectedCluster(null);
    setHoverTooltip(null);
    setViewport(next);
    void loadWindow(next, false, { showLoading: true });
  };

  const pan = (direction: -1 | 1) => {
    const current = viewportRef.current;
    const span = current.to - current.from;
    const liveBoundary = Date.now();
    const nextTo = Math.min(liveBoundary, current.to + direction * span * 0.5);
    if (direction === 1 && nextTo >= liveBoundary - 1_000) {
      jumpToNow();
      return;
    }
    const next = { from: nextTo - span, to: nextTo };
    setSelectedCluster(null);
    setLiveMode(false);
    setViewport(next);
    void loadWindow(next, false);
  };

  const handleDataZoom = useCallback((event: TimelineDataZoomEvent) => {
    const currentData = dataRef.current;
    if (!currentData) return;
    const currentQuery = { from: currentData.from, to: currentData.to };
    const zoomed = dataZoomWindow(event, currentQuery);
    if (!zoomed) return;
    const now = Date.now();
    const next = clampTimelineWindow(zoomed, now);
    setSelection("custom");
    setSelectedCluster(null);
    setLiveMode(false);
    setViewport(next);
    if (navigationTimerRef.current !== undefined) window.clearTimeout(navigationTimerRef.current);
    navigationTimerRef.current = window.setTimeout(() => {
      if (timelineNeedsRefill(next, currentQuery, now)) void loadWindow(next, false);
    }, 250);
  }, [loadWindow, setLiveMode, setViewport]);

  const hideHoverTooltip = useCallback(() => {
    if (hoverFrameRef.current !== undefined) window.cancelAnimationFrame(hoverFrameRef.current);
    hoverFrameRef.current = undefined;
    setHoverTooltip((current) => current?.pinned ? current : null);
  }, []);

  const clearHoverTooltip = useCallback(() => {
    if (hoverFrameRef.current !== undefined) window.cancelAnimationFrame(hoverFrameRef.current);
    hoverFrameRef.current = undefined;
    setHoverTooltip(null);
  }, []);

  const handleChartPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (hoverTooltip?.pinned) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const plotWidth = rect.width - metricGrid.left - metricGrid.right;
    if (plotWidth <= 0 || x < metricGrid.left || x > metricGrid.left + plotWidth) {
      hideHoverTooltip();
      return;
    }
    const timestamp = viewport.from + (x - metricGrid.left) / plotWidth * (viewport.to - viewport.from);
    const html = timelineHoverTooltipHtml(timestamp, data?.samples ?? [], enabled, clusters, viewport.to - viewport.from, formatDate);
    if (hoverFrameRef.current !== undefined) window.cancelAnimationFrame(hoverFrameRef.current);
    hoverFrameRef.current = window.requestAnimationFrame(() => {
      hoverFrameRef.current = undefined;
      setHoverTooltip({
        x,
        y: rect.top - (visualizationRef.current?.getBoundingClientRect().top ?? rect.top) + metricGrid.top + 8,
        timestamp,
        html,
        alignEnd: x > rect.width * 0.68,
        pinned: false
      });
    });
  }, [clusters, data?.samples, enabled, formatDate, hideHoverTooltip, hoverTooltip?.pinned, metricGrid, viewport]);

  const pinHoverTooltip = useCallback(() => {
    setHoverTooltip((current) => current ? { ...current, pinned: !current.pinned } : current);
  }, []);

  const handleChartInteractionChange = useCallback((interacting: boolean) => {
    if (interacting) stableAnnotationGridTopRef.current = nextAnnotationGridTop;
    setChartInteracting(interacting);
    if (interacting) hideHoverTooltip();
  }, [hideHoverTooltip, nextAnnotationGridTop]);

  const handleTimelineWheel = useCallback((event: globalThis.WheelEvent) => {
    const rect = (event.currentTarget as HTMLDivElement).getBoundingClientRect();
    const plotWidth = rect.width - metricGrid.left - metricGrid.right;
    if (plotWidth <= 0) return false;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopImmediatePropagation();
      const current = viewportRef.current;
      const now = Date.now();
      const next = zoomTimelineWindowAtPixel(current, event.deltaY, event.clientX - rect.left - metricGrid.left, plotWidth, now);
      setSelection("custom");
      setSelectedCluster(null);
      setLiveMode(false);
      setViewport(next);
      if (navigationTimerRef.current !== undefined) window.clearTimeout(navigationTimerRef.current);
      navigationTimerRef.current = window.setTimeout(() => {
        const currentData = dataRef.current;
        const currentQuery = currentData ? { from: currentData.from, to: currentData.to } : timelineQueryWindow(next, false);
        if (timelineNeedsRefill(next, currentQuery, now)) void loadWindow(next, false);
      }, 250);
      return true;
    }
    const horizontalPixels = timelineHorizontalWheelPixels(event, plotWidth);
    if (!horizontalPixels) return false;
    event.preventDefault();
    event.stopImmediatePropagation();
    const current = viewportRef.current;
    const now = Date.now();
    const next = panTimelineWindowByPixels(current, horizontalPixels, plotWidth, now);
    setSelection("custom");
    setLiveMode(false);
    setViewport(next);
    if (navigationTimerRef.current !== undefined) window.clearTimeout(navigationTimerRef.current);
    navigationTimerRef.current = window.setTimeout(() => {
      const currentData = dataRef.current;
      const currentQuery = currentData ? { from: currentData.from, to: currentData.to } : timelineQueryWindow(next, false);
      if (timelineNeedsRefill(next, currentQuery, now)) void loadWindow(next, false);
    }, 250);
    return true;
  }, [loadWindow, metricGrid, setLiveMode, setViewport]);

  const metricOptions = useMemo(() => new Map(metricBands.map((band) => [band.key, buildTimelineChartOption({
    samples: data?.samples ?? [],
    query,
    viewport,
    enabled,
    clusters,
    palette,
    formatTime,
    formatShortTime,
    now: clockNow,
    gridOverride: metricGrid,
    seriesKeys: band.series
  })])), [clockNow, clusters, data?.samples, enabled, formatShortTime, formatTime, metricBands, metricGrid, palette, query, viewport]);

  return (
    <section ref={panelRef} className="panel serverTimelinePanel" aria-busy={loading}>
      <PanelHeader
        compact
        title="Server Timeline"
        help={<HelpTooltip label="server timeline">Compare resource use with players, events, and schedules. Drag or scroll horizontally to pan; hold Ctrl or Command while scrolling to zoom.</HelpTooltip>}
        actions={<div className="serverTimelineHeaderControls">
          <span className={`serverTimelineMode tone-${live ? "live" : "history"}`} aria-live="polite"><i aria-hidden="true" />{live ? "Live" : "Historical"}</span>
          <div className="serverTimelineRangeControls" role="group" aria-label="Timeline range">
            {timelineRanges.map((candidate) => (
              <Button
                variant="ghost"
                compact
                key={candidate.label}
                className={selection === candidate.label ? "active" : ""}
                onClick={() => selectPreset(candidate.label)}
                aria-pressed={selection === candidate.label}
              >{candidate.label}</Button>
            ))}
            {selection === "custom" && <span className="serverTimelineCustomRange" aria-live="polite">Custom</span>}
          </div>
        </div>}
      />
      {loading && <LoadingLabel>Loading server timeline</LoadingLabel>}
      <div className="serverTimelineToolbar">
        <div className="serverTimelineLayerGroups">
          <div className="serverTimelineLayerGroup" role="group" aria-label="Metric layers">
            <span className="serverTimelineLayerHeading">Metrics</span>
            <div className="serverTimelineSeries">
              {seriesOptions.map((series) => (
                <button
                  type="button"
                  key={series.key}
                  className={`timelineSeriesToggle series-${series.key}${enabled[series.key] ? " active" : ""}`}
                  aria-pressed={enabled[series.key]}
                  onClick={() => toggleMetricLayer(series.key)}
                >
                  <span aria-hidden="true" />{series.label}
                </button>
              ))}
            </div>
          </div>
          <div className="serverTimelineLayerGroup" role="group" aria-label="Event layers">
            <span className="serverTimelineLayerHeading">Events</span>
            <div className="serverTimelineSeries">
              {annotationOptions.filter((annotation) => annotation.key !== "automation" || data?.scheduleAnnotationsAvailable).map((annotation) => (
                <button
                  type="button"
                  key={annotation.key}
                  className={`timelineSeriesToggle timelineAnnotationToggle tone-${annotation.key}${annotationEnabled[annotation.key] ? " active" : ""}`}
                  aria-pressed={annotationEnabled[annotation.key]}
                  onClick={() => {
                    setSelectedCluster(null);
                    setAnnotationEnabled((current) => ({ ...current, [annotation.key]: !current[annotation.key] }));
                  }}
                >
                  <span aria-hidden="true" />{annotation.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="serverTimelineNavigation">
          {!live && <Button variant="secondary" compact onClick={jumpToNow}>Jump to now</Button>}
          <Button variant="secondary" compact onClick={resetView} disabled={selection !== "custom"}>Reset view</Button>
          <Button variant="secondary" compact onClick={() => pan(-1)} aria-label="Earlier timeline window">‹</Button>
          <Button variant="secondary" compact onClick={() => pan(1)} aria-label="Later timeline window" disabled={live}>›</Button>
        </div>
      </div>
      {error && <Banner tone="warning" compact title="Timeline refresh failed" message={`${error}. Previously loaded data is still shown.`} />}
      {data?.truncated.schedules && <Banner tone="warning" compact title="Schedule markers were limited" message="Some high-frequency markers were omitted because this window exceeds the annotation limit." />}
      {!loading && resourceState === "unavailable" && <Banner tone="warning" compact title="Resource history is unavailable" message="Event and schedule annotations are still shown for this window." />}
      <div
        ref={visualizationRef}
        className="serverTimelineVisualization"
        role="group"
        aria-label="Server resource and event timeline"
        style={{ "--timeline-label-gutter": `${labelGutter}px` } as React.CSSProperties}
      >
        <section
          className={`serverTimelineEventRail${visibleEventCount ? "" : " is-empty"}`}
          aria-label="Timeline events"
          style={{ height: annotationGridTop }}
        >
          <div className="serverTimelineEventRailGutter" style={{ width: metricGrid.left }}>
            <strong>Events</strong>
            <span>{activeScheduleRanges.length
              ? `${activeScheduleRanges.length} active · ${visibleEventCount} total`
              : visibleEventCount
                ? `${visibleEventCount} in this range`
                : "None in this range"}</span>
          </div>
          <div className="serverTimelineEventRailTrack" style={{ marginRight: metricGrid.right }}>
            <div ref={annotationRailRef} className="serverTimelineAnnotations" aria-label="Timeline annotations">
              {positionedClusters.map((cluster) => {
                const occurrenceCount = timelineClusterOccurrenceCount(cluster);
                const iconMarkers = timelineClusterIconMarkers(cluster);
                return (
                  <div
                    key={cluster.id}
                    className={`timelineAnnotationMarker tone-${cluster.tone}`}
                    style={{ left: `${cluster.leftPercent}%` }}
                  >
                    <button
                      type="button"
                      className={`timelineAnnotationCluster${occurrenceCount > 1 ? " is-multiple" : ""}${cluster.inlineLabel ? " is-labeled" : ""}${cluster.alignEnd ? " align-end" : ""}`}
                      style={{ top: `${cluster.labelTop}px` }}
                      title={markerTitle(cluster, formatDate)}
                      aria-label={markerTitle(cluster, formatDate)}
                      aria-expanded={selectedCluster?.id === cluster.id}
                      // Only the open cluster owns the popover; pointing every
                      // marker at an id that is not in the document makes the
                      // relationship unresolvable for assistive technology.
                      aria-controls={selectedCluster?.id === cluster.id ? "server-timeline-annotation-popover" : undefined}
                      onClick={() => {
                        setHoverTooltip(null);
                        setSelectedCluster((current) => current?.id === cluster.id ? null : cluster);
                      }}
                    >
                      <span className="timelineAnnotationIconStack" aria-hidden="true">
                        {iconMarkers.map((marker, index) => (
                          <span className={`timelineAnnotationClusterIcon tone-${marker.tone}`} key={`${marker.id}:${index}`}>
                            {timelineMarkerGlyph(marker)}
                          </span>
                        ))}
                      </span>
                      {occurrenceCount > 1 && <span className="timelineAnnotationClusterCount">{occurrenceCount} events</span>}
                      {cluster.inlineLabel && <span className="timelineAnnotationClusterLabel" aria-hidden="true">{cluster.inlineLabel}</span>}
                    </button>
                  </div>
                );
              })}
            </div>
            {visibleActiveScheduleRanges.length > 0 && (
              <div
                className="serverTimelineActiveSchedules"
                style={{ top: baseAnnotationGridTop + activeScheduleRowGap / 2 }}
                aria-label="Active schedule runs"
              >
                {visibleActiveScheduleRanges.map((range, index) => (
                  <button
                    key={range.marker.id}
                    type="button"
                    className={`timelineActiveScheduleRun align-${range.align}${range.clippedStart ? " is-clipped-start" : ""}${range.clippedEnd ? " is-clipped-end" : ""}`}
                    style={{
                      left: `${range.leftPercent}%`,
                      top: index * activeScheduleRowHeight,
                      width: `${range.widthPercent}%`
                    }}
                    aria-label={range.accessibleLabel}
                    title={`${range.statusLabel} · running for ${range.durationLabel}`}
                    onClick={() => activateMarker(range.marker)}
                  >
                    <span className="timelineActiveScheduleLine" aria-hidden="true" />
                    <span className="timelineActiveScheduleStart" aria-hidden="true" />
                    <span className="timelineActiveScheduleEnd" aria-hidden="true" />
                    <span className="timelineActiveScheduleLabel" aria-hidden="true">
                      <strong>{range.marker.schedule?.scheduleName}</strong>
                      <small>{range.statusLabel} · {range.durationLabel}</small>
                    </span>
                  </button>
                ))}
              </div>
            )}
            {!visibleEventCount && !loading && (
              <span className="serverTimelineEventRailEmpty">No server events or automation runs here</span>
            )}
            {selectedCluster && selectedPosition && (
              <section
                ref={annotationPopoverRef}
                className="serverTimelineAnnotationPopover"
                id="server-timeline-annotation-popover"
                aria-label="Events at selected time"
                style={{ left: `${Math.max(22, Math.min(78, selectedPosition.leftPercent))}%` }}
              >
                <div className="serverTimelineAnnotationPopoverHeader">
                  <div>
                    <strong>{timelineClusterOccurrenceCount(selectedCluster)} {timelineClusterOccurrenceCount(selectedCluster) === 1 ? "event" : "events"}</strong>
                    <span>{formatDate(selectedCluster.occurredAt)}</span>
                  </div>
                  <Button variant="ghost" compact onClick={() => setSelectedCluster(null)} aria-label="Close events popover">×</Button>
                </div>
                <div className="serverTimelineAnnotationPopoverList">
                  {selectedCluster.markers.map((marker) => (
                    <TimelineAnnotationPopoverItem
                      key={marker.id}
                      marker={marker}
                      formatDate={formatDate}
                      onOpenSchedule={activateMarker}
                    />
                  ))}
                </div>
              </section>
            )}
          </div>
        </section>
        {annotationEnabled.player && (
          <PlayerSessionSection
            rows={playerRows}
            query={query}
            viewport={viewport}
            now={clockNow}
            palette={palette}
            formatTime={formatTime}
            formatShortTime={formatShortTime}
            gridLeft={metricGrid.left}
            playerHeadSourceFor={playerHeadsEnabled ? playerHeadSourceFor : undefined}
            interacting={chartInteracting}
            onDataZoom={handleDataZoom}
            onInteractionChange={handleChartInteractionChange}
            onPointerEnter={clearHoverTooltip}
            onWheel={handleTimelineWheel}
          />
        )}
        {annotationEnabled.player && data && (data.playerActivity?.snapshotState ?? "unavailable") === "unavailable" && (
          <Banner tone="warning" compact className="serverTimelinePlayerAlert" title="Current player status is unavailable" message="Retained sessions are shown as offline." />
        )}
        <div className="serverTimelineMetricBands">
          {metricBands.map((band) => (
            <section className={`serverTimelineMetricBand${band.prominent ? " is-prominent" : " is-compact"}`} key={band.key} aria-label={`${band.label} timeline`}>
              <strong className={`serverTimelineMetricBandLabel tone-${band.key}`}>{band.label}</strong>
              <EChartsCanvas
                option={metricOptions.get(band.key)!}
                onDataZoom={handleDataZoom}
                onInteractionChange={handleChartInteractionChange}
                onPointerMove={handleChartPointerMove}
                onPointerLeave={hideHoverTooltip}
                onClick={pinHoverTooltip}
                onWheel={handleTimelineWheel}
              />
            </section>
          ))}
          {!metricBands.length && <div className="serverTimelineEmpty">Enable a metric to display its chart.</div>}
        </div>
        {sharedGuide && <span
          className={`serverTimelineSharedGuide${sharedGuide.pinned ? " is-pinned" : ""}${sharedGuide.tone ? ` tone-${sharedGuide.tone}` : ""}`}
          style={{ left: sharedGuide.x, top: sharedGuide.top }}
          aria-hidden="true"
        />}
        {hoverTooltip && (
          <div
            className={`serverTimelineHoverTooltip${hoverTooltip.alignEnd ? " align-end" : ""}${hoverTooltip.pinned ? " is-pinned" : ""}`}
            style={{ left: hoverTooltip.x + (hoverTooltip.alignEnd ? -14 : 14), top: hoverTooltip.y }}
            aria-live={hoverTooltip.pinned ? "polite" : undefined}
            dangerouslySetInnerHTML={{ __html: hoverTooltip.html }}
          />
        )}
      </div>
      {!loading && !data?.samples.length && !markers.length && <div className="serverTimelineEmpty">No timeline data is available for this window.</div>}
    </section>
  );
}
