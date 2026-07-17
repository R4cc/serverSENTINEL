import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ScheduleNavigationTarget,
  ServerTimelineEvent,
  ServerTimelineResourcePoint,
  ServerTimelineResponse,
  ServerTimelineScheduleMarker
} from "../types";
import { EChartsCanvas, type TimelineDataZoomEvent } from "./EChartsCanvas";
import {
  buildTimelineChartOption,
  dataZoomWindow,
  defaultTimelinePalette,
  liveTimelineWindow,
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
export type SeriesKey = "cpuPercent" | "memoryUsageBytes" | "networkRxBytesPerSecond" | "networkTxBytesPerSecond";
export type TimelineWindow = { from: number; to: number };
type LoadTimeline = (from: number, to: number, maxPoints: number) => Promise<ServerTimelineResponse>;

export type TimelineMarker = {
  id: string;
  occurredAt: number;
  label: string;
  tone: "join" | "leave" | "server" | "schedule";
  event?: ServerTimelineEvent;
  schedule?: ServerTimelineScheduleMarker;
};

type AnnotationKey = TimelineMarker["tone"];

export type MarkerCluster = {
  id: string;
  occurredAt: number;
  markers: TimelineMarker[];
  tone: TimelineMarker["tone"];
  slot: number;
  slotCount: number;
};

const seriesOptions: Array<{ key: SeriesKey; label: string }> = [
  { key: "cpuPercent", label: "CPU Usage" },
  { key: "memoryUsageBytes", label: "Memory Usage" },
  { key: "networkRxBytesPerSecond", label: "Network In" },
  { key: "networkTxBytesPerSecond", label: "Network Out" }
];

const annotationOptions: Array<{ key: AnnotationKey; label: string }> = [
  { key: "join", label: "Player joins" },
  { key: "leave", label: "Player leaves" },
  { key: "server", label: "Server events" },
  { key: "schedule", label: "Schedules" }
];

function eventTone(event: ServerTimelineEvent): TimelineMarker["tone"] {
  if (event.eventType === "player_joined") return "join";
  if (event.eventType === "player_left") return "leave";
  return "server";
}

export function timelineMarkers(data: ServerTimelineResponse | null): TimelineMarker[] {
  if (!data) return [];
  return [
    ...data.events.map((event) => ({
      id: `event:${event.id}`,
      occurredAt: event.occurredAt,
      label: event.message,
      tone: eventTone(event),
      event
    })),
    ...data.schedules.map((schedule) => ({
      id: schedule.id,
      occurredAt: schedule.occurredAt,
      label: schedule.kind === "upcoming" ? `${schedule.scheduleName} scheduled` : `${schedule.scheduleName}: ${schedule.status}`,
      tone: "schedule" as const,
      schedule
    }))
  ].sort((left, right) => left.occurredAt - right.occurredAt || left.id.localeCompare(right.id));
}

export function clusterTimelineMarkers(markers: TimelineMarker[], from: number, to: number, slots = 24): MarkerCluster[] {
  if (!markers.length || to <= from) return [];
  const bucketMs = Math.max(1, (to - from) / slots);
  const buckets = new Map<number, TimelineMarker[]>();
  for (const marker of markers) {
    if (marker.occurredAt < from || marker.occurredAt > to) continue;
    const bucket = Math.max(0, Math.min(slots - 1, Math.floor((marker.occurredAt - from) / bucketMs)));
    const existing = buckets.get(bucket) ?? [];
    existing.push(marker);
    buckets.set(bucket, existing);
  }
  return [...buckets.entries()].map(([bucket, grouped]) => ({
    id: `cluster:${bucket}:${grouped.map((marker) => marker.id).join(":")}`,
    occurredAt: Math.round(grouped.reduce((total, marker) => total + marker.occurredAt, 0) / grouped.length),
    markers: grouped,
    tone: grouped.length === 1 ? grouped[0].tone : grouped.some((marker) => marker.tone === "server") ? "server" : grouped[0].tone,
    slot: bucket,
    slotCount: slots
  }));
}

export type PositionedMarkerCluster = MarkerCluster & {
  leftPercent: number;
  lane: number;
  alignEnd: boolean;
};

export function positionTimelineClusters(clusters: MarkerCluster[], from: number, to: number, laneCount = 4): PositionedMarkerCluster[] {
  if (to <= from) return [];
  const laneEnds = Array.from({ length: laneCount }, () => Number.NEGATIVE_INFINITY);
  return clusters.map((cluster) => {
    const leftPercent = Math.max(0, Math.min(100, (cluster.occurredAt - from) / (to - from) * 100));
    const alignEnd = leftPercent > 82;
    const start = alignEnd ? leftPercent - 16 : leftPercent - 2;
    const end = alignEnd ? leftPercent + 2 : leftPercent + 16;
    let lane = laneEnds.findIndex((laneEnd) => laneEnd + 1 <= start);
    if (lane < 0) lane = laneEnds.indexOf(Math.min(...laneEnds));
    laneEnds[lane] = end;
    return { ...cluster, leftPercent, lane, alignEnd };
  });
}

function truncateTimelineLabel(value: string, maximum = 14) {
  return value.length > maximum ? `${value.slice(0, maximum - 1)}…` : value;
}

export function timelineMarkerShortLabel(marker: TimelineMarker) {
  const event = marker.event;
  if (event?.subject && event.eventType === "player_joined") return `${truncateTimelineLabel(event.subject)} joined`;
  if (event?.subject && event.eventType === "player_left") return `${truncateTimelineLabel(event.subject)} left`;
  if (event?.eventType === "server_started") return "Server started";
  if (event?.eventType === "server_stopped") return "Server stopped";
  if (event?.eventType === "server_crashed") return "Server crashed";
  if (event?.eventType === "server_overloaded") return "Server overloaded";
  if (event?.eventType === "exception_caught") return "Exception caught";
  if (event?.eventType === "mod_disabled") return `${truncateTimelineLabel(event.subject ?? "Mod")} disabled`;
  if (marker.schedule) return `${truncateTimelineLabel(marker.schedule.scheduleName)} ${marker.schedule.kind === "upcoming" ? "scheduled" : marker.schedule.status}`;
  return truncateTimelineLabel(marker.label, 22);
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

function readTimelinePalette(element: HTMLElement): TimelinePalette {
  const styles = getComputedStyle(element);
  const read = (property: string, fallback: string) => styles.getPropertyValue(property).trim() || fallback;
  return {
    cpu: read("--timeline-cpu", defaultTimelinePalette.cpu),
    memory: read("--timeline-memory", defaultTimelinePalette.memory),
    networkIn: read("--timeline-network-in", defaultTimelinePalette.networkIn),
    networkOut: read("--timeline-network-out", defaultTimelinePalette.networkOut),
    join: read("--timeline-join", defaultTimelinePalette.join),
    leave: read("--timeline-leave", defaultTimelinePalette.leave),
    server: read("--timeline-server", defaultTimelinePalette.server),
    schedule: read("--timeline-schedule", defaultTimelinePalette.schedule),
    accent: read("--accent", defaultTimelinePalette.accent),
    text: read("--text", defaultTimelinePalette.text),
    textMuted: read("--text-muted", defaultTimelinePalette.textMuted),
    border: read("--border-subtle", defaultTimelinePalette.border),
    surface: read("--surface-raised", defaultTimelinePalette.surface)
  };
}

function useTimelinePresentation(panelRef: React.RefObject<HTMLElement | null>) {
  const [palette, setPalette] = useState(defaultTimelinePalette);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => {
      setReducedMotion(media.matches);
      const next = readTimelinePalette(panel);
      setPalette((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    const shell = panel.closest(".appShell");
    if (shell) observer.observe(shell, { attributes: true, attributeFilter: ["class", "style"] });
    media.addEventListener("change", update);
    update();
    return () => {
      observer.disconnect();
      media.removeEventListener("change", update);
    };
  }, [panelRef]);

  return { palette, reducedMotion };
}

export function ServerTimeline({
  loadTimeline,
  formatTime,
  formatShortTime,
  formatDate,
  onLatestSample,
  onOpenConsole,
  onOpenSchedules
}: {
  loadTimeline: LoadTimeline;
  formatTime: (value: string | number | Date) => string;
  formatShortTime: (value: string | number | Date) => string;
  formatDate: (value: string | number | Date) => string;
  onLatestSample?: (sample?: ServerTimelineResourcePoint) => void;
  onOpenConsole: () => void;
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
  const [enabled, setEnabled] = useState<Record<SeriesKey, boolean>>({
    cpuPercent: true,
    memoryUsageBytes: true,
    networkRxBytesPerSecond: true,
    networkTxBytesPerSecond: true
  });
  const [annotationEnabled, setAnnotationEnabled] = useState<Record<AnnotationKey, boolean>>({
    join: true,
    leave: true,
    server: true,
    schedule: true
  });
  const panelRef = useRef<HTMLElement>(null);
  const viewportRef = useRef(viewport);
  const dataRef = useRef<ServerTimelineResponse | null>(null);
  const liveRef = useRef(live);
  const lastFullLoadRef = useRef(0);
  const requestIdRef = useRef(0);
  const navigationTimerRef = useRef<number | undefined>(undefined);
  const { palette, reducedMotion } = useTimelinePresentation(panelRef);

  const setViewport = useCallback((next: TimelineWindow) => {
    viewportRef.current = next;
    setViewportState(next);
  }, []);

  const setLiveMode = useCallback((next: boolean) => {
    liveRef.current = next;
    setLive(next);
  }, []);

  const loadWindow = useCallback(async (nextViewport: TimelineWindow, nextLive: boolean, options: { showLoading?: boolean; incremental?: boolean } = {}) => {
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
      setData(next);
      onLatestSample?.(next.latest);
      setError("");
    } catch (requestError) {
      if (requestId === requestIdRef.current) setError((requestError as Error).message || "Timeline data is unavailable");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }, [loadTimeline, onLatestSample]);

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
      if (document.hidden) return;
      const span = viewportRef.current.to - viewportRef.current.from;
      const next = liveTimelineWindow(span);
      setClockNow(Date.now());
      setViewport(next);
      void loadWindow(next, true, { incremental: true });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [live, loadWindow, setViewport]);

  useEffect(() => {
    if (!selectedCluster) return;
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setSelectedCluster(null);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [selectedCluster]);

  const allMarkers = useMemo(() => timelineMarkers(data), [data]);
  const markers = useMemo(() => allMarkers.filter((marker) => annotationEnabled[marker.tone]), [allMarkers, annotationEnabled]);
  const clusters = useMemo(() => clusterTimelineMarkers(markers, viewport.from, viewport.to), [markers, viewport.from, viewport.to]);
  const positionedClusters = useMemo(() => positionTimelineClusters(clusters, viewport.from, viewport.to), [clusters, viewport.from, viewport.to]);
  const selectedPosition = selectedCluster ? positionedClusters.find((cluster) => cluster.id === selectedCluster.id) : undefined;
  const query = useMemo<TimelineWindow>(() => data ? { from: data.from, to: data.to } : timelineQueryWindow(viewport, live), [data, live, viewport]);
  const resourceState = useMemo(() => {
    if (!data?.samples.length) return "empty";
    const available = data.samples.filter((point) => point.available && point.running && point.cpuPercent !== null && point.memoryUsageBytes !== null).length;
    if (available === 0) return "unavailable";
    if (available < data.samples.length) return "partial";
    return "available";
  }, [data]);

  const activateMarker = useCallback((marker: TimelineMarker) => {
    const schedule = marker.schedule;
    if (!schedule) {
      onOpenConsole();
      return;
    }
    if (schedule.kind === "run" && schedule.runId) onOpenSchedules({ kind: "completed-run", scheduleId: schedule.scheduleId, runId: schedule.runId });
    else if (schedule.kind === "active" && schedule.runId) onOpenSchedules({ kind: "active-run", scheduleId: schedule.scheduleId, runId: schedule.runId });
    else onOpenSchedules({ kind: "schedule", scheduleId: schedule.scheduleId });
  }, [onOpenConsole, onOpenSchedules]);

  const selectPreset = (range: TimelineRange) => {
    const span = timelineRanges.find((candidate) => candidate.label === range)?.milliseconds ?? initialSpan;
    const next = liveTimelineWindow(span);
    setSelection(range);
    setSelectedCluster(null);
    setLastPreset(range);
    setLiveMode(true);
    setClockNow(Date.now());
    setViewport(next);
    void loadWindow(next, true, { showLoading: true });
  };

  const jumpToNow = () => selectPreset(lastPreset);

  const pan = (direction: -1 | 1) => {
    const current = viewportRef.current;
    const span = current.to - current.from;
    const liveBoundary = Date.now() + span * 0.1;
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

  const chartOption = useMemo(() => buildTimelineChartOption({
    samples: data?.samples ?? [],
    query,
    viewport,
    enabled,
    clusters,
    palette,
    formatTime,
    formatShortTime,
    formatDate,
    reducedMotion,
    now: clockNow
  }), [clockNow, clusters, data?.samples, enabled, formatDate, formatShortTime, formatTime, palette, query, reducedMotion, viewport]);

  return (
    <section ref={panelRef} className="panel serverTimelinePanel" aria-busy={loading}>
      <PanelHeader
        title="Server Timeline"
        description="Correlate resource usage with player activity, server events, and schedules. Drag to pan; use Ctrl or Command with the wheel to zoom."
        actions={<div className="serverTimelineRangeControls" role="group" aria-label="Timeline range">
          <Button variant="ghost" compact className={live ? "active" : ""} onClick={jumpToNow} aria-pressed={live}>Live</Button>
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
        </div>}
      />
      {loading && <LoadingLabel>Loading server timeline</LoadingLabel>}
      <div className="serverTimelineToolbar">
        <div className="serverTimelineSeries" role="group" aria-label="Timeline series">
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
          {annotationOptions.filter((annotation) => annotation.key !== "schedule" || data?.scheduleAnnotationsAvailable).map((annotation) => (
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
        <div className="serverTimelineNavigation">
          {!live && <Button variant="secondary" compact onClick={jumpToNow}>Jump to now</Button>}
          <Button variant="secondary" compact onClick={() => pan(-1)} aria-label="Earlier timeline window">‹</Button>
          <Button variant="secondary" compact onClick={() => pan(1)} aria-label="Later timeline window" disabled={live}>›</Button>
        </div>
      </div>
      {error && <div className="serverTimelineNotice tone-warning">{error}. Previously loaded data is still shown.</div>}
      {data?.truncated.schedules && <div className="serverTimelineNotice tone-warning">Some high-frequency schedule markers were grouped because this window exceeds the annotation limit.</div>}
      {!loading && resourceState === "unavailable" && <div className="serverTimelineNotice tone-warning">Resource history is unavailable for this window. Event and schedule annotations are still shown.</div>}
      {!loading && resourceState === "partial" && <div className="serverTimelineNotice">Some resource samples are unavailable, so gaps are preserved in the chart.</div>}
      <div className="serverTimelineChart" role="group" aria-label="Server resource and event timeline">
        <EChartsCanvas option={chartOption} onDataZoom={handleDataZoom} />
        <div className="serverTimelineAnnotations" aria-label="Timeline annotations">
          {positionedClusters.map((cluster) => {
            const glyph = cluster.markers.length > 1 ? String(cluster.markers.length)
              : cluster.tone === "join" ? "+" : cluster.tone === "leave" ? "−" : cluster.tone === "server" ? "!" : "S";
            const label = cluster.markers.length > 1 ? `${cluster.markers.length} events` : timelineMarkerShortLabel(cluster.markers[0]);
            return (
              <button
                type="button"
                key={cluster.id}
                className={`timelineAnnotationLabel tone-${cluster.tone}${cluster.alignEnd ? " align-end" : ""}`}
                style={{ left: `${cluster.leftPercent}%`, top: `${7 + cluster.lane * 30}px` }}
                title={markerTitle(cluster, formatDate)}
                aria-label={markerTitle(cluster, formatDate)}
                aria-expanded={cluster.markers.length > 1 ? selectedCluster?.id === cluster.id : undefined}
                aria-controls={cluster.markers.length > 1 ? "server-timeline-annotation-popover" : undefined}
                onClick={() => cluster.markers.length > 1
                  ? setSelectedCluster((current) => current?.id === cluster.id ? null : cluster)
                  : activateMarker(cluster.markers[0])}
              ><span className="timelineAnnotationGlyph" aria-hidden="true">{glyph}</span><span className="timelineAnnotationLabelText" aria-hidden="true">{label}</span></button>
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
                <strong>{selectedCluster.markers.length} events</strong>
                <span>{formatDate(selectedCluster.occurredAt)}</span>
              </div>
              <Button variant="ghost" compact onClick={() => setSelectedCluster(null)} aria-label="Close events popover">×</Button>
            </div>
            <div className="serverTimelineAnnotationPopoverList">
              {selectedCluster.markers.map((marker) => (
                <button
                  type="button"
                  className={`serverTimelineAnnotationPopoverItem tone-${marker.tone}`}
                  key={marker.id}
                  onClick={() => activateMarker(marker)}
                >
                  <span className="serverTimelineAnnotationPopoverGlyph" aria-hidden="true">
                    {marker.tone === "join" ? "+" : marker.tone === "leave" ? "−" : marker.tone === "server" ? "!" : "S"}
                  </span>
                  <span>
                    <strong>{marker.label}</strong>
                    <small>Open {marker.schedule ? "Schedules" : "Console"}</small>
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
      {!loading && !data?.samples.length && !markers.length && <div className="serverTimelineEmpty">No timeline data is available for this window.</div>}
    </section>
  );
}
