import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ScheduleNavigationTarget,
  ServerTimelineEvent,
  ServerTimelineResourcePoint,
  ServerTimelineResponse,
  ServerTimelineScheduleMarker
} from "../types";
import { playerEventSubject, playerReconnectWindowMs, samePlayerName } from "../utils/serverEvents";
import { EChartsCanvas, type TimelineDataZoomEvent } from "./EChartsCanvas";
import { EventIcon } from "./EventIcon";
import {
  buildTimelineChartOption,
  dataZoomWindow,
  defaultTimelinePalette,
  liveTimelineWindow,
  timelineChartGrid,
  timelineChartGridForEnabled,
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
  { label: "6h", milliseconds: 6 * 60 * 60 * 1000 },
  { label: "24h", milliseconds: 24 * 60 * 60 * 1000 }
] as const;

type TimelineRange = typeof timelineRanges[number]["label"];
type TimelineSelection = TimelineRange | "custom";
export type SeriesKey = "cpuUtilizationPercent" | "memoryUtilizationPercent" | "networkRxBytesPerSecond" | "networkTxBytesPerSecond" | "playersOnline";
export type TimelineWindow = { from: number; to: number };
type LoadTimeline = (from: number, to: number, maxPoints: number) => Promise<ServerTimelineResponse>;

export type TimelineMarker = {
  id: string;
  occurredAt: number;
  label: string;
  tone: "join" | "leave" | "server" | "automation" | "planned";
  event?: ServerTimelineEvent;
  reconnect?: {
    player: string;
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
      </span>
      <span className="serverTimelineAnnotationPopoverItemBody">
        <strong>{marker.label}</strong>
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
  { key: "memoryUtilizationPercent", label: "Memory" },
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

function eventTone(event: ServerTimelineEvent): TimelineMarker["tone"] {
  if (event.eventType === "player_joined") return "join";
  if (event.eventType === "player_left") return "leave";
  return "server";
}

export function timelineMarkers(data: ServerTimelineResponse | null): TimelineMarker[] {
  if (!data) return [];
  const eventMarkers: TimelineMarker[] = [];
  const events = [...data.events].sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const next = events[index + 1];
    const player = playerEventSubject(event);
    const nextPlayer = next ? playerEventSubject(next) : "";
    const reconnectDuration = next ? next.occurredAt - event.occurredAt : Number.POSITIVE_INFINITY;
    if (
      event.eventType === "player_left"
      && next?.eventType === "player_joined"
      && samePlayerName(player, nextPlayer)
      && reconnectDuration >= 0
      && reconnectDuration <= playerReconnectWindowMs
    ) {
      eventMarkers.push({
        id: `reconnect:${event.id}:${next.id}`,
        occurredAt: next.occurredAt,
        label: `${nextPlayer} reconnected`,
        tone: "join",
        event: next,
        reconnect: {
          player: nextPlayer,
          durationSeconds: Math.round(reconnectDuration / 1_000),
          events: [event, next]
        }
      });
      index += 1;
      continue;
    }
    eventMarkers.push({
      id: `event:${event.id}`,
      occurredAt: event.occurredAt,
      label: event.message,
      tone: eventTone(event),
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
    const previous = current?.at(-1);
    if (!current || !previous || marker.occurredAt - previous.occurredAt >= bucketMs) groups.push([marker]);
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
  if (marker.reconnect) return { primary: "Player reconnected", secondary: marker.reconnect.player };
  const event = marker.event;
  if (event?.eventType === "player_joined") return { primary: "Player joined", secondary: event.subject };
  if (event?.eventType === "player_left") return { primary: "Player left", secondary: event.subject };
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

function clusterIsImportant(cluster: MarkerCluster) {
  return cluster.markers.some(timelineMarkerIsImportant);
}

export const maxTimelineMarkerPreviews = 4;

export function timelineMarkerPreview(cluster: MarkerCluster) {
  const markers = cluster.markers.slice(0, maxTimelineMarkerPreviews);
  return { markers, remaining: Math.max(0, cluster.markers.length - markers.length) };
}

function estimatedMarkerLabelWidth(cluster: MarkerCluster) {
  const preview = timelineMarkerPreview(cluster);
  const displays = preview.markers.map(timelineMarkerDisplayLabel);
  const overflowLabel = preview.remaining > 0 ? `${preview.remaining} more ${preview.remaining === 1 ? "event" : "events"}` : "";
  const longestLine = Math.max(overflowLabel.length, ...displays.flatMap((display) => [display.primary.length, display.secondary?.length ?? 0]));
  return Math.min(220, Math.max(108, 46 + longestLine * 6));
}

function estimatedMarkerLabelHeight(cluster: MarkerCluster) {
  if (cluster.markers.length === 1) return 30;
  const preview = timelineMarkerPreview(cluster);
  return 4 + preview.markers.length * 28 + (preview.remaining > 0 ? 24 : 0);
}

export function positionTimelineClusters(clusters: MarkerCluster[], from: number, to: number, railWidth = 1_000, laneCount = 2): PositionedMarkerCluster[] {
  if (to <= from) return [];
  const availableWidth = Math.max(1, railWidth);
  const laneEnds = Array.from({ length: laneCount }, () => Number.NEGATIVE_INFINITY);
  const positioned = clusters.map((cluster) => {
    const leftPercent = Math.max(0, Math.min(100, (cluster.occurredAt - from) / (to - from) * 100));
    const center = availableWidth * leftPercent / 100;
    const labelWidth = estimatedMarkerLabelWidth(cluster);
    const alignEnd = center + labelWidth - 12 > availableWidth + 120;
    // Allocate lanes around the event anchor rather than around the label's
    // current left/right alignment. The interval then translates with a pan,
    // so crossing the edge-alignment threshold cannot reshuffle nearby labels.
    const start = center - labelWidth / 2;
    const end = center + labelWidth / 2;
    let lane = laneEnds.findIndex((laneEnd) => laneEnd + 6 <= start);
    if (lane < 0) lane = laneEnds.indexOf(Math.min(...laneEnds));
    laneEnds[lane] = end;
    return { ...cluster, leftPercent, lane, alignEnd, labelHeight: estimatedMarkerLabelHeight(cluster) };
  });
  const laneHeights = Array.from({ length: laneCount }, (_, lane) => Math.max(0, ...positioned.filter((cluster) => cluster.lane === lane).map((cluster) => cluster.labelHeight)));
  const laneTops = laneHeights.map((_, lane) => 2 + laneHeights.slice(0, lane).reduce((total, height) => total + height + 4, 0));
  return positioned.map((cluster) => ({ ...cluster, labelTop: laneTops[cluster.lane] }));
}

export function timelineAnnotationGridTop(clusters: PositionedMarkerCluster[]) {
  return Math.max(timelineChartGrid.top, ...clusters.map((cluster) => cluster.labelTop + cluster.labelHeight + 6));
}

function uniqueBy<T>(items: T[], key: (item: T) => string | number) {
  return [...new Map(items.map((item) => [key(item), item])).values()];
}

export function mergeTimelineResponses(current: ServerTimelineResponse, incoming: ServerTimelineResponse, from: number, to: number): ServerTimelineResponse {
  return {
    ...incoming,
    from,
    to,
    latest: incoming.latest ?? current.latest,
    samples: uniqueBy([...current.samples, ...incoming.samples], (point) => point.sampledAt)
      .filter((point) => point.sampledAt >= from && point.sampledAt <= to)
      .sort((left, right) => left.sampledAt - right.sampledAt),
    events: uniqueBy([...current.events, ...incoming.events], (event) => event.id)
      .filter((event) => event.occurredAt >= from && event.occurredAt <= to)
      .sort((left, right) => left.occurredAt - right.occurredAt),
    schedules: incoming.scheduleAnnotationsAvailable
      ? uniqueBy([...current.schedules, ...incoming.schedules], (marker) => marker.id)
          .filter((marker) => marker.occurredAt >= from && marker.occurredAt <= to)
          .sort((left, right) => left.occurredAt - right.occurredAt)
      : [],
    truncated: { schedules: current.truncated.schedules || incoming.truncated.schedules }
  };
}

function markerTitle(cluster: MarkerCluster, formatDate: (value: string | number | Date) => string) {
  return cluster.markers.map((marker) => `${formatDate(marker.occurredAt)} — ${marker.label}`).join("\n");
}

function timelineMarkerGlyph(marker: TimelineMarker) {
  if (marker.reconnect) return <EventIcon kind="player_reconnected" />;
  if (marker.tone === "join") return <EventIcon kind="player_joined" />;
  if (marker.tone === "leave") return <EventIcon kind="player_left" />;
  if (marker.tone === "server") return "!";
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
  const initialSpan = timelineRanges[2].milliseconds;
  const [selection, setSelection] = useState<TimelineSelection>("1h");
  const [lastPreset, setLastPreset] = useState<TimelineRange>("1h");
  const [live, setLive] = useState(true);
  const [viewport, setViewportState] = useState<TimelineWindow>(() => liveTimelineWindow(initialSpan));
  const [data, setData] = useState<ServerTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [clockNow, setClockNow] = useState(Date.now());
  const [selectedCluster, setSelectedCluster] = useState<MarkerCluster | null>(null);
  const [annotationRailWidth, setAnnotationRailWidth] = useState(1_000);
  const [hoverTooltip, setHoverTooltip] = useState<TimelineHoverTooltip | null>(null);
  const [chartInteracting, setChartInteracting] = useState(false);
  const [enabled, setEnabled] = useState<Record<SeriesKey, boolean>>({
    cpuUtilizationPercent: true,
    memoryUtilizationPercent: true,
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
  const annotationRailRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef(viewport);
  const dataRef = useRef<ServerTimelineResponse | null>(null);
  const liveRef = useRef(live);
  const lastFullLoadRef = useRef(0);
  const requestIdRef = useRef(0);
  const navigationTimerRef = useRef<number | undefined>(undefined);
  const hoverFrameRef = useRef<number | undefined>(undefined);
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

  useEffect(() => () => {
    if (hoverFrameRef.current !== undefined) window.cancelAnimationFrame(hoverFrameRef.current);
  }, []);

  const allMarkers = useMemo(() => timelineMarkers(data), [data]);
  const markers = useMemo(() => allMarkers.filter((marker) => {
    if (marker.tone === "join" || marker.tone === "leave") return annotationEnabled.player;
    return annotationEnabled[marker.tone];
  }), [allMarkers, annotationEnabled]);
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
  const chartGrid = useMemo(() => timelineChartGridForEnabled(enabled, annotationGridTop), [annotationGridTop, enabled]);
  const resourceState = useMemo(() => {
    if (!data?.samples.length) return "empty";
    const available = data.samples.filter((point) => point.available && point.running && (point.cpuUtilizationPercent !== null || point.memoryUtilizationPercent !== null)).length;
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
    setSelection(range);
    setSelectedCluster(null);
    setHoverTooltip(null);
    setClockNow(Date.now());
    navigationPendingRef.current = true;
    void loadWindow(next, nextLive, {
      showLoading: true,
      commitViewport: true,
      onCommit: () => {
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
    const plotWidth = rect.width - chartGrid.left - chartGrid.right;
    const plotBottom = rect.height - chartGrid.bottom;
    if (plotWidth <= 0 || x < chartGrid.left || x > chartGrid.left + plotWidth || y < chartGrid.top || y > plotBottom) {
      hideHoverTooltip();
      return;
    }
    const timestamp = viewport.from + (x - chartGrid.left) / plotWidth * (viewport.to - viewport.from);
    const html = timelineHoverTooltipHtml(timestamp, data?.samples ?? [], enabled, clusters, viewport.to - viewport.from, formatDate);
    if (hoverFrameRef.current !== undefined) window.cancelAnimationFrame(hoverFrameRef.current);
    hoverFrameRef.current = window.requestAnimationFrame(() => {
      hoverFrameRef.current = undefined;
      setHoverTooltip({
        x,
        timestamp,
        html,
        alignEnd: x > rect.width * 0.68,
        pinned: false
      });
    });
  }, [chartGrid, clusters, data?.samples, enabled, formatDate, hideHoverTooltip, hoverTooltip?.pinned, viewport]);

  const pinHoverTooltip = useCallback(() => {
    setHoverTooltip((current) => current ? { ...current, pinned: !current.pinned } : current);
  }, []);

  const handleChartInteractionChange = useCallback((interacting: boolean) => {
    if (interacting) stableAnnotationGridTopRef.current = nextAnnotationGridTop;
    setChartInteracting(interacting);
    if (interacting) hideHoverTooltip();
  }, [hideHoverTooltip, nextAnnotationGridTop]);

  const chartOption = useMemo(() => buildTimelineChartOption({
    samples: data?.samples ?? [],
    query,
    viewport,
    enabled,
    clusters,
    palette,
    formatTime,
    formatShortTime,
    now: clockNow,
    gridTop: annotationGridTop
  }), [annotationGridTop, clockNow, clusters, data?.samples, enabled, formatShortTime, formatTime, palette, query, viewport]);

  return (
    <section ref={panelRef} className="panel serverTimelinePanel" aria-busy={loading}>
      <PanelHeader
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
          <Button variant="secondary" compact onClick={resetView} disabled={live && selection !== "custom"}>Reset view</Button>
          <Button variant="secondary" compact onClick={() => pan(-1)} aria-label="Earlier timeline window">‹</Button>
          <Button variant="secondary" compact onClick={() => pan(1)} aria-label="Later timeline window" disabled={live}>›</Button>
        </div>
      </div>
      {error && <div className="serverTimelineNotice tone-warning">{error}. Previously loaded data is still shown.</div>}
      {data?.truncated.schedules && <div className="serverTimelineNotice tone-warning">Some high-frequency schedule markers were grouped because this window exceeds the annotation limit.</div>}
      {!loading && resourceState === "unavailable" && <div className="serverTimelineNotice tone-warning">Resource history is unavailable for this window. Event and schedule annotations are still shown.</div>}
      <div
        className="serverTimelineChart"
        role="group"
        aria-label="Server resource and event timeline"
        style={{ "--timeline-annotation-extra": `${annotationGridTop - timelineChartGrid.top}px` } as React.CSSProperties}
      >
        <EChartsCanvas
          option={chartOption}
          onDataZoom={handleDataZoom}
          onInteractionChange={handleChartInteractionChange}
          onPointerMove={handleChartPointerMove}
          onPointerLeave={hideHoverTooltip}
          onClick={pinHoverTooltip}
        />
        {hoverTooltip && <span
          className={`serverTimelineCursor${hoverTooltip.pinned ? " is-pinned" : ""}`}
          style={{ left: hoverTooltip.x, top: chartGrid.top, bottom: chartGrid.bottom }}
          aria-hidden="true"
        />}
        {hoverTooltip && (
          <div
            className={`serverTimelineHoverTooltip${hoverTooltip.alignEnd ? " align-end" : ""}${hoverTooltip.pinned ? " is-pinned" : ""}`}
            style={{ left: hoverTooltip.x + (hoverTooltip.alignEnd ? -14 : 14), top: chartGrid.top + 8 }}
            aria-live={hoverTooltip.pinned ? "polite" : undefined}
            dangerouslySetInnerHTML={{ __html: hoverTooltip.html }}
          />
        )}
        <div ref={annotationRailRef} className="serverTimelineAnnotations" aria-label="Timeline annotations" style={{ left: chartGrid.left, right: chartGrid.right }}>
          {positionedClusters.map((cluster) => {
            const stacked = cluster.markers.length > 1;
            const preview = timelineMarkerPreview(cluster);
            const displayLabel = timelineMarkerDisplayLabel(cluster.markers[0]);
            const important = clusterIsImportant(cluster);
            return (
              <div
                key={cluster.id}
                className={`timelineAnnotationMarker tone-${cluster.tone}${cluster.tone === "planned" ? " is-planned" : ""}`}
                style={{ left: `${cluster.leftPercent}%` }}
              >
                <span
                  className="timelineAnnotationConnector"
                  style={{ top: `${cluster.labelTop + cluster.labelHeight / 2}px`, width: `${Math.min(5, 2.5 + (cluster.markers.length - 1) * 0.75)}px` }}
                  aria-hidden="true"
                />
                <button
                  type="button"
                  className={`timelineAnnotationLabel is-expanded${stacked ? " is-stack" : ""}${cluster.alignEnd ? " align-end" : ""}${important ? " is-important" : ""}`}
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
                  {stacked ? (
                    <>
                      {preview.markers.map((marker) => {
                        const rowLabel = timelineMarkerDisplayLabel(marker);
                        return (
                          <span className={`timelineAnnotationPreviewRow tone-${marker.tone}`} key={marker.id} aria-hidden="true">
                            <span className="timelineAnnotationGlyph">{timelineMarkerGlyph(marker)}</span>
                            <span className="timelineAnnotationLabelText">
                              <strong>{rowLabel.primary}</strong>
                              {rowLabel.secondary && <small>{rowLabel.secondary}</small>}
                            </span>
                          </span>
                        );
                      })}
                      {preview.remaining > 0 && (
                        <span className="timelineAnnotationMore" aria-hidden="true">
                          {preview.remaining} more {preview.remaining === 1 ? "event" : "events"}
                        </span>
                      )}
                    </>
                  ) : (
                    <>
                      <span className="timelineAnnotationGlyph" aria-hidden="true">{timelineMarkerGlyph(cluster.markers[0])}</span>
                      <span className="timelineAnnotationLabelText" aria-hidden="true">
                        <strong>{displayLabel.primary}</strong>
                        {displayLabel.secondary && <small>{displayLabel.secondary}</small>}
                      </span>
                    </>
                  )}
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
                <strong>{selectedCluster.markers.length} {selectedCluster.markers.length === 1 ? "event" : "events"}</strong>
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
      {!loading && !data?.samples.length && !markers.length && <div className="serverTimelineEmpty">No timeline data is available for this window.</div>}
    </section>
  );
}
