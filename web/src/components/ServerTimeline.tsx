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
import { EventIcon } from "./EventIcon";
import {
  buildPlayerTimelineChartOption,
  formatTimelineDuration,
  playerTimelineRowHeight,
  timelineSessionGeometry,
  type PlayerTimelineRow,
  type TimelineSessionGeometry
} from "./playerTimelineChart";
import { RuntimeControlIcon } from "./RuntimeControls";
import {
  buildTimelineChartOption,
  dataZoomWindow,
  defaultTimelinePalette,
  liveTimelineWindow,
  timelineChartGrid,
  timelineMetricBandGrid,
  timelineHoverTooltipHtml,
  timelineNeedsRefill,
  timelineQueryWindow,
  type TimelinePalette
} from "./serverTimelineChart";
import { Button, LoadingLabel, PanelHeader } from "./UiPrimitives";

const timelineRanges = [
  { label: "5m", milliseconds: 5 * 60 * 1000 },
  { label: "15m", milliseconds: 15 * 60 * 1000 },
  { label: "1h", milliseconds: 60 * 60 * 1000 },
  { label: "3h", milliseconds: 3 * 60 * 60 * 1000 },
  { label: "6h", milliseconds: 6 * 60 * 60 * 1000 },
  { label: "24h", milliseconds: 24 * 60 * 60 * 1000 }
] as const;

type TimelineRange = typeof timelineRanges[number]["label"];
type TimelineSelection = TimelineRange | "custom";
const defaultTimelineRange: TimelineRange = "1h";
export type SeriesKey = "cpuUtilizationPercent" | "memoryUsageBytes" | "networkRxBytesPerSecond" | "networkTxBytesPerSecond" | "playersOnline";
export type TimelineWindow = { from: number; to: number };
type LoadTimeline = (from: number, to: number, maxPoints: number) => Promise<ServerTimelineResponse>;

type MetricBand = {
  key: "cpu" | "memory" | "network" | "players";
  label: string;
  series: SeriesKey[];
  prominent: boolean;
};

export type TimelinePlayerRow = PlayerTimelineRow;
export type { TimelineSessionGeometry };
export { formatTimelineDuration, timelineSessionGeometry };

export type TimelineMarker = {
  id: string;
  occurredAt: number;
  label: string;
  tone: "server" | "automation" | "planned";
  event?: ServerTimelineEvent;
  occurrences?: number;
  restart?: {
    durationSeconds: number;
    events: [ServerTimelineEvent, ServerTimelineEvent];
  };
  schedule?: ServerTimelineScheduleMarker;
};

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

type AnnotationKey = "player" | "server" | "automation" | "planned";

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

const annotationOptions: Array<{ key: AnnotationKey; label: string }> = [
  { key: "player", label: "Player activity" },
  { key: "server", label: "Server events" },
  { key: "automation", label: "Automation runs" },
  { key: "planned", label: "Planned schedules" }
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
  const rows = new Map<string, TimelinePlayerRow>();
  for (const player of activity.onlineNames) rows.set(player.toLocaleLowerCase(), { player, online: true, sessions: [] });
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
      label: schedule.kind === "upcoming" ? `${schedule.scheduleName} scheduled` : `${schedule.scheduleName}: ${schedule.status}`,
      tone: schedule.kind === "upcoming" ? "planned" as const : "automation" as const,
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

export type PositionedMarkerCluster = MarkerCluster & {
  leftPercent: number;
  lane: number;
  alignEnd: boolean;
  inlineLabel: string | null;
  labelTop: number;
  labelHeight: number;
};

export type TimelineMarkerDisplayLabel = {
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
    secondary: marker.schedule.kind === "upcoming" ? "Scheduled" : capitalizeTimelineLabel(marker.schedule.status)
  };
  return { primary: marker.label };
}

export function timelineMarkerIsImportant(marker: TimelineMarker) {
  if (marker.schedule) return marker.schedule.status === "failed" || marker.schedule.status === "running";
  return Boolean(marker.event && [
    "server_started",
    "server_stopped",
    "server_crashed",
    "server_overloaded",
    "exception_caught",
    "mod_disabled"
  ].includes(marker.event.eventType));
}

export const maxTimelineClusterIcons = 3;

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

function uniqueBy<T>(items: T[], key: (item: T) => string | number) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

function timelineEventIdentity(event: ServerTimelineEvent) {
  return [event.source, event.occurredAt, event.signature, event.message, event.details ?? ""].join("\u0000");
}

export function mergeTimelineResponses(current: ServerTimelineResponse, incoming: ServerTimelineResponse, from: number, to: number): ServerTimelineResponse {
  const incomingGeneratedAt = new Date(incoming.generatedAt).getTime();
  const retainedSchedules = Number.isFinite(incomingGeneratedAt)
    ? current.schedules.filter((marker) => marker.kind !== "upcoming" || marker.occurredAt > incomingGeneratedAt)
    : current.schedules;
  const playerActivity = incoming.playerActivity || current.playerActivity
    ? {
        ...(current.playerActivity ?? { snapshotState: "unavailable" as const, onlineNames: [], sessions: [] }),
        ...(incoming.playerActivity ?? {}),
        sessions: uniqueBy([
          ...(incoming.playerActivity?.sessions ?? []),
          ...(current.playerActivity?.sessions ?? []).filter((session) => !incoming.playerActivity?.sessions.some((candidate) => candidate.id === session.id))
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
      ? uniqueBy([...retainedSchedules, ...incoming.schedules], (marker) => marker.id)
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

function timelineMarkerGlyph(marker: TimelineMarker) {
  if (marker.restart) return <RuntimeControlIcon action="restart" />;
  if (marker.event?.eventType === "server_started") return <RuntimeControlIcon action="start" />;
  if (marker.event?.eventType === "server_stopped") return <RuntimeControlIcon action="stop" />;
  if (marker.event) return <EventIcon kind={marker.event.eventType} />;
  return marker.tone === "planned" ? "○" : "▶";
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
    planned: read("--timeline-schedule", defaultTimelinePalette.planned),
    accent: read("--accent", defaultTimelinePalette.accent),
    text: read("--text", defaultTimelinePalette.text),
    textMuted: read("--text-muted", defaultTimelinePalette.textMuted),
    border: read("--border-subtle", defaultTimelinePalette.border),
    surface: read("--surface-raised", defaultTimelinePalette.surface)
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
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    const shell = panel.closest(".appShell");
    if (shell) observer.observe(shell, { attributes: true, attributeFilter: ["class", "style"] });
    update();
    return () => observer.disconnect();
  }, [panelRef]);

  return palette;
}

function PlayerStatusIcon({ online }: { online: boolean }) {
  return (
    <span className={`serverTimelinePlayerStatus tone-${online ? "online" : "offline"}`} aria-label={online ? "Online now" : "Offline now"}>
      <EventIcon kind={online ? "player_joined" : "player_left"} />
    </span>
  );
}

function PlayerSessionSection({
  rows,
  query,
  viewport,
  now,
  palette,
  formatShortTime,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onWheel
}: {
  rows: TimelinePlayerRow[];
  query: TimelineWindow;
  viewport: TimelineWindow;
  now: number;
  palette: TimelinePalette;
  formatShortTime: (value: string | number | Date) => string;
  onPointerDown: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLDivElement>) => void;
  onWheel: (event: React.WheelEvent<HTMLDivElement>) => void;
}) {
  const onlineRows = rows.filter((row) => row.online);
  const offlineRows = rows.filter((row) => !row.online);
  const ticks = Array.from({ length: 7 }, (_, index) => viewport.from + (viewport.to - viewport.from) * index / 6);
  const renderGroup = (label: string, groupRows: TimelinePlayerRow[], online: boolean) => {
    if (!groupRows.length) return null;
    const option = buildPlayerTimelineChartOption({ rows: groupRows, query, viewport, now, palette, formatShortTime });
    return (
      <section className={`serverTimelinePlayerGroup tone-${online ? "online" : "offline"}`} aria-label={`${label}, ${groupRows.length} players`}>
        <div className="serverTimelinePlayerGroupHeader">
          <span>{label}</span><small>({groupRows.length})</small>
        </div>
        <div className="serverTimelinePlayerGroupBody" style={{ height: groupRows.length * playerTimelineRowHeight }}>
          <div className="serverTimelinePlayerIdentities">
            {groupRows.map((row) => (
              <div className="serverTimelinePlayerIdentity" key={row.player.toLocaleLowerCase()}>
                <PlayerStatusIcon online={row.online} />
                <strong title={row.player}>{row.player}</strong>
              </div>
            ))}
          </div>
          <div className="serverTimelinePlayerChart" aria-label={`${label} session chart`}>
            <EChartsCanvas option={option} onDataZoom={() => undefined} />
          </div>
        </div>
      </section>
    );
  };

  return (
    <section className="serverTimelinePlayers" aria-label="Player sessions">
      <div className="serverTimelinePlayerAxis" aria-hidden="true">
        <span />
        <div>{ticks.map((tick, index) => <time key={tick} dateTime={new Date(tick).toISOString()} style={{ left: `${index / 6 * 100}%` }}>{formatShortTime(tick)}</time>)}</div>
      </div>
      <div
        className="serverTimelinePlayerScroller"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        {renderGroup("Online now", onlineRows, true)}
        {renderGroup("Played in this time range", offlineRows, false)}
        {!rows.length && <div className="serverTimelinePlayerEmpty">No player sessions are available for this time range.</div>}
      </div>
    </section>
  );
}

export function ServerTimeline({
  loadTimeline,
  formatTime,
  formatShortTime,
  formatDate,
  onLatestSample,
  onOpenSchedules
}: {
  loadTimeline: LoadTimeline;
  formatTime: (value: string | number | Date) => string;
  formatShortTime: (value: string | number | Date) => string;
  formatDate: (value: string | number | Date) => string;
  onLatestSample?: (sample?: ServerTimelineResourcePoint) => void;
  onOpenSchedules: (target?: ScheduleNavigationTarget) => void;
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
  const [enabled, setEnabled] = useState<Record<SeriesKey, boolean>>({
    cpuUtilizationPercent: true,
    memoryUsageBytes: true,
    networkRxBytesPerSecond: false,
    networkTxBytesPerSecond: false,
    playersOnline: false
  });
  const [annotationEnabled, setAnnotationEnabled] = useState<Record<AnnotationKey, boolean>>({
    player: true,
    server: true,
    automation: true,
    planned: true
  });
  const panelRef = useRef<HTMLElement>(null);
  const visualizationRef = useRef<HTMLDivElement>(null);
  const annotationRailRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef(viewport);
  const dataRef = useRef<ServerTimelineResponse | null>(null);
  const liveRef = useRef(live);
  const lastFullLoadRef = useRef(0);
  const requestIdRef = useRef(0);
  const navigationTimerRef = useRef<number | undefined>(undefined);
  const hoverFrameRef = useRef<number | undefined>(undefined);
  const sessionDragRef = useRef<{ pointerId: number; startX: number; viewport: TimelineWindow } | null>(null);
  const palette = useTimelinePresentation(panelRef);
  const navigationPendingRef = useRef(false);

  const setViewport = useCallback((next: TimelineWindow) => {
    viewportRef.current = next;
    setViewportState(next);
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
    const query = timelineQueryWindow(nextViewport, nextLive);
    const current = dataRef.current;
    const now = Date.now();
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
      if (options.commitViewport) setViewport(nextViewport);
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

  useEffect(() => {
    if (!live) return;
    const interval = window.setInterval(() => {
      if (document.hidden || navigationPendingRef.current) return;
      const span = viewportRef.current.to - viewportRef.current.from;
      const next = liveTimelineWindow(span);
      setClockNow(Date.now());
      setViewport(next);
      void loadWindow(next, true, { incremental: true });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [live, loadWindow, setViewport]);

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
    const rail = annotationRailRef.current;
    if (!rail) return;
    const updateWidth = () => setAnnotationRailWidth(Math.max(1, rail.getBoundingClientRect().width));
    const observer = new ResizeObserver(updateWidth);
    observer.observe(rail);
    updateWidth();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const element = visualizationRef.current;
    if (!element) return;
    const updateWidth = () => setVisualizationWidth(Math.max(1, element.getBoundingClientRect().width));
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    updateWidth();
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (hoverFrameRef.current !== undefined) window.cancelAnimationFrame(hoverFrameRef.current);
  }, []);

  const allMarkers = useMemo(() => timelineMarkers(data), [data]);
  const markers = useMemo(() => allMarkers.filter((marker) => annotationEnabled[marker.tone]), [allMarkers, annotationEnabled]);
  const clusters = useMemo(() => clusterTimelineMarkers(markers, viewport.from, viewport.to), [markers, viewport.from, viewport.to]);
  const positionedClusters = useMemo(
    () => positionTimelineClusters(clusters, viewport.from, viewport.to, annotationRailWidth),
    [annotationRailWidth, clusters, viewport.from, viewport.to]
  );
  const nextAnnotationGridTop = useMemo(() => timelineAnnotationGridTop(positionedClusters), [positionedClusters]);
  // Panning changes annotation clusters continuously. Keep their reserved rail
  // height fixed until the gesture ends so the chart does not bounce vertically.
  const stableAnnotationGridTopRef = useRef(nextAnnotationGridTop);
  const annotationGridTop = chartInteracting ? stableAnnotationGridTopRef.current : nextAnnotationGridTop;
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
    const next = dataZoomWindow(event, currentQuery);
    if (!next) return;
    const previousSpan = viewportRef.current.to - viewportRef.current.from;
    const nextSpan = next.to - next.from;
    if (Math.abs(nextSpan - previousSpan) > previousSpan * 0.01) setSelection("custom");
    setSelectedCluster(null);
    setLiveMode(false);
    setViewport(next);
    if (navigationTimerRef.current !== undefined) window.clearTimeout(navigationTimerRef.current);
    navigationTimerRef.current = window.setTimeout(() => {
      if (timelineNeedsRefill(next, currentQuery)) void loadWindow(next, false);
    }, 250);
  }, [loadWindow, setLiveMode, setViewport]);

  const hideHoverTooltip = useCallback(() => {
    if (hoverFrameRef.current !== undefined) window.cancelAnimationFrame(hoverFrameRef.current);
    hoverFrameRef.current = undefined;
    setHoverTooltip((current) => current?.pinned ? current : null);
  }, []);

  const handleChartPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (hoverTooltip?.pinned) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const plotWidth = rect.width - metricGrid.left - metricGrid.right;
    const plotBottom = rect.height - metricGrid.bottom;
    if (plotWidth <= 0 || x < metricGrid.left || x > metricGrid.left + plotWidth || y < metricGrid.top || y > plotBottom) {
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

  const handleSessionPointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX - rect.left < metricGrid.left) return;
    sessionDragRef.current = { pointerId: event.pointerId, startX: event.clientX, viewport: viewportRef.current };
    event.currentTarget.setPointerCapture(event.pointerId);
    stableAnnotationGridTopRef.current = nextAnnotationGridTop;
    setChartInteracting(true);
    hideHoverTooltip();
  }, [hideHoverTooltip, metricGrid.left, nextAnnotationGridTop]);

  const handleSessionPointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = sessionDragRef.current;
    const rect = event.currentTarget.getBoundingClientRect();
    const plotWidth = rect.width - metricGrid.left - metricGrid.right;
    if (drag?.pointerId === event.pointerId && plotWidth > 0) {
      const delta = -(event.clientX - drag.startX) / plotWidth * (drag.viewport.to - drag.viewport.from);
      setSelection("custom");
      setLiveMode(false);
      setViewport({ from: drag.viewport.from + delta, to: drag.viewport.to + delta });
      return;
    }
    if (hoverTooltip?.pinned || plotWidth <= 0) return;
    const x = event.clientX - rect.left;
    if (x < metricGrid.left || x > metricGrid.left + plotWidth) {
      hideHoverTooltip();
      return;
    }
    const timestamp = viewport.from + (x - metricGrid.left) / plotWidth * (viewport.to - viewport.from);
    setHoverTooltip({
      x,
      y: rect.top - (visualizationRef.current?.getBoundingClientRect().top ?? rect.top) + 8,
      timestamp,
      html: timelineHoverTooltipHtml(timestamp, data?.samples ?? [], enabled, clusters, viewport.to - viewport.from, formatDate),
      alignEnd: x > rect.width * 0.68,
      pinned: false
    });
  }, [clusters, data?.samples, enabled, formatDate, hideHoverTooltip, hoverTooltip?.pinned, metricGrid, setLiveMode, setViewport, viewport]);

  const handleSessionPointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const drag = sessionDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    sessionDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setChartInteracting(false);
    const next = viewportRef.current;
    const currentQuery = dataRef.current ? { from: dataRef.current.from, to: dataRef.current.to } : timelineQueryWindow(next, false);
    if (timelineNeedsRefill(next, currentQuery)) void loadWindow(next, false);
  }, [loadWindow]);

  const handleSessionWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const plotWidth = rect.width - metricGrid.left - metricGrid.right;
    if (plotWidth <= 0) return;
    const fraction = Math.max(0, Math.min(1, (event.clientX - rect.left - metricGrid.left) / plotWidth));
    const current = viewportRef.current;
    const currentSpan = current.to - current.from;
    const nextSpan = Math.max(60_000, Math.min(24 * 60 * 60 * 1000, currentSpan * Math.exp(event.deltaY * 0.0015)));
    const anchor = current.from + currentSpan * fraction;
    const next = { from: anchor - nextSpan * fraction, to: anchor + nextSpan * (1 - fraction) };
    setSelection("custom");
    setLiveMode(false);
    setViewport(next);
    if (navigationTimerRef.current !== undefined) window.clearTimeout(navigationTimerRef.current);
    navigationTimerRef.current = window.setTimeout(() => void loadWindow(next, false), 250);
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
        description="Correlate resource usage with player activity, server events, and schedules. Drag to pan; use Ctrl or Command with the wheel to zoom."
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
                  onClick={() => setEnabled((current) => ({ ...current, [series.key]: !current[series.key] }))}
                >
                  <span aria-hidden="true" />{series.label}
                </button>
              ))}
            </div>
          </div>
          <div className="serverTimelineLayerGroup" role="group" aria-label="Event layers">
            <span className="serverTimelineLayerHeading">Events</span>
            <div className="serverTimelineSeries">
              {annotationOptions.filter((annotation) => !["automation", "planned"].includes(annotation.key) || data?.scheduleAnnotationsAvailable).map((annotation) => (
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
      {error && <div className="serverTimelineNotice tone-warning">{error}. Previously loaded data is still shown.</div>}
      {data?.truncated.schedules && <div className="serverTimelineNotice tone-warning">Some high-frequency schedule markers were omitted because this window exceeds the annotation limit.</div>}
      {!loading && resourceState === "unavailable" && <div className="serverTimelineNotice tone-warning">Resource history is unavailable for this window. Event and schedule annotations are still shown.</div>}
      <div
        ref={visualizationRef}
        className="serverTimelineVisualization"
        role="group"
        aria-label="Server resource and event timeline"
        style={{ "--timeline-label-gutter": `${labelGutter}px` } as React.CSSProperties}
      >
        <div className="serverTimelineAnnotationStage" style={{ height: annotationGridTop }}>
        <div ref={annotationRailRef} className="serverTimelineAnnotations" aria-label="Timeline annotations" style={{ left: metricGrid.left, right: metricGrid.right }}>
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
                  aria-controls="server-timeline-annotation-popover"
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
        {selectedCluster && selectedPosition && (
          <section
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
        {annotationEnabled.player && (
          <PlayerSessionSection
            rows={playerRows}
            query={query}
            viewport={viewport}
            now={clockNow}
            palette={palette}
            formatShortTime={formatShortTime}
            onPointerDown={handleSessionPointerDown}
            onPointerMove={handleSessionPointerMove}
            onPointerUp={handleSessionPointerUp}
            onWheel={handleSessionWheel}
          />
        )}
        {annotationEnabled.player && data?.playerActivity?.snapshotState === "unavailable" && (
          <div className="serverTimelinePlayerStatusNotice">Current player status is unavailable; retained sessions are shown as offline.</div>
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
