import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import type {
  ScheduleNavigationTarget,
  ServerTimelineEvent,
  ServerTimelineResourcePoint,
  ServerTimelineResponse,
  ServerTimelineScheduleMarker
} from "../types";
import { Button, LoadingLabel, PanelHeader } from "./UiPrimitives";

const timelineRanges = [
  { label: "5m", milliseconds: 5 * 60 * 1000 },
  { label: "15m", milliseconds: 15 * 60 * 1000 },
  { label: "1h", milliseconds: 60 * 60 * 1000 },
  { label: "6h", milliseconds: 6 * 60 * 60 * 1000 },
  { label: "24h", milliseconds: 24 * 60 * 60 * 1000 }
] as const;

type TimelineRange = typeof timelineRanges[number]["label"];
type SeriesKey = "cpuPercent" | "memoryUsageBytes" | "networkRxBytesPerSecond" | "networkTxBytesPerSecond";
type LoadTimeline = (from: number, to: number, maxPoints: number) => Promise<ServerTimelineResponse>;

type TimelineMarker = {
  id: string;
  occurredAt: number;
  label: string;
  tone: "join" | "leave" | "server" | "schedule";
  event?: ServerTimelineEvent;
  schedule?: ServerTimelineScheduleMarker;
};

type MarkerCluster = {
  id: string;
  occurredAt: number;
  markers: TimelineMarker[];
  tone: TimelineMarker["tone"];
};

const seriesOptions: Array<{ key: SeriesKey; label: string; shortLabel: string }> = [
  { key: "cpuPercent", label: "CPU Usage", shortLabel: "CPU" },
  { key: "memoryUsageBytes", label: "Memory Usage", shortLabel: "Memory" },
  { key: "networkRxBytesPerSecond", label: "Network In", shortLabel: "Net In" },
  { key: "networkTxBytesPerSecond", label: "Network Out", shortLabel: "Net Out" }
];

function formatBytes(value: number) {
  if (value < 1024) return `${Math.max(0, value).toFixed(0)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(0)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatRate(value: number) {
  return `${formatBytes(value)}/s`;
}

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
    const bucket = Math.max(0, Math.min(slots - 1, Math.floor((marker.occurredAt - from) / bucketMs)));
    const existing = buckets.get(bucket) ?? [];
    existing.push(marker);
    buckets.set(bucket, existing);
  }
  return [...buckets.entries()].map(([bucket, grouped]) => ({
    id: `cluster:${bucket}:${grouped.map((marker) => marker.id).join(":")}`,
    occurredAt: Math.round(grouped.reduce((total, marker) => total + marker.occurredAt, 0) / grouped.length),
    markers: grouped,
    tone: grouped.length === 1 ? grouped[0].tone : grouped.some((marker) => marker.tone === "server") ? "server" : grouped[0].tone
  }));
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

function AnnotationLabel({
  props,
  cluster,
  formatDate,
  onActivate
}: {
  props: unknown;
  cluster: MarkerCluster;
  formatDate: (value: string | number | Date) => string;
  onActivate: () => void;
}) {
  const viewBox = (props as { viewBox?: { x?: number; y?: number } })?.viewBox;
  const x = viewBox?.x ?? 0;
  const y = (viewBox?.y ?? 0) + 6;
  const label = cluster.markers.length > 1 ? `${cluster.markers.length} events` : cluster.markers[0].label;
  const activateFromKeyboard = (event: KeyboardEvent<SVGGElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onActivate();
    }
  };
  return (
    <g
      className={`timelineAnnotationLabel tone-${cluster.tone}`}
      transform={`translate(${x},${y})`}
      role="button"
      tabIndex={0}
      aria-label={markerTitle(cluster, formatDate)}
      onClick={onActivate}
      onKeyDown={activateFromKeyboard}
    >
      <title>{markerTitle(cluster, formatDate)}</title>
      <circle r="7" />
      <text x="11" y="4">{label.length > 22 ? `${label.slice(0, 21)}…` : label}</text>
    </g>
  );
}

function TimelineTooltip({
  active,
  payload,
  label,
  clusters,
  span,
  formatDate
}: {
  active?: boolean;
  payload?: readonly { dataKey?: unknown; value?: unknown; name?: string | number }[];
  label?: string | number;
  clusters: MarkerCluster[];
  span: number;
  formatDate: (value: string | number | Date) => string;
}) {
  const timestamp = Number(label);
  if (!active || !Number.isFinite(timestamp)) return null;
  const nearby = clusters.filter((cluster) => Math.abs(cluster.occurredAt - timestamp) <= span / 80);
  return (
    <div className="serverTimelineTooltip">
      <strong>{formatDate(timestamp)}</strong>
      {payload?.map((entry) => {
        const value = Number(entry.value);
        if (!Number.isFinite(value)) return null;
        const formatted = entry.dataKey === "cpuPercent" ? `${value.toFixed(1)}%`
          : entry.dataKey === "memoryUsageBytes" ? formatBytes(value)
            : formatRate(value);
        return <span key={String(entry.dataKey)}><i className={`timelineTooltipSwatch series-${String(entry.dataKey)}`} />{entry.name}: {formatted}</span>;
      })}
      {nearby.flatMap((cluster) => cluster.markers).map((marker) => <span className="timelineTooltipEvent" key={marker.id}>{marker.label}</span>)}
    </div>
  );
}

export function ServerTimeline({
  loadTimeline,
  formatTime,
  formatDate,
  onLatestSample,
  onOpenConsole,
  onOpenSchedules
}: {
  loadTimeline: LoadTimeline;
  formatTime: (value: string | number | Date) => string;
  formatDate: (value: string | number | Date) => string;
  onLatestSample?: (sample?: ServerTimelineResourcePoint) => void;
  onOpenConsole: () => void;
  onOpenSchedules: (target?: ScheduleNavigationTarget) => void;
}) {
  const [range, setRange] = useState<TimelineRange>("1h");
  const [live, setLive] = useState(true);
  const [historicalTo, setHistoricalTo] = useState<number | null>(null);
  const [data, setData] = useState<ServerTimelineResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [enabled, setEnabled] = useState<Record<SeriesKey, boolean>>({
    cpuPercent: true,
    memoryUsageBytes: true,
    networkRxBytesPerSecond: true,
    networkTxBytesPerSecond: true
  });
  const dataRef = useRef<ServerTimelineResponse | null>(null);
  const lastFullLoadRef = useRef(0);
  const selectedRange = timelineRanges.find((candidate) => candidate.label === range) ?? timelineRanges[2];
  const span = selectedRange.milliseconds;

  const refresh = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    const now = Date.now();
    const to = live ? now + span * 0.1 : historicalTo ?? now + span * 0.1;
    const from = to - span;
    try {
      const current = dataRef.current;
      const generatedAt = current ? new Date(current.generatedAt).getTime() : NaN;
      const incremental = Boolean(
        live
        && !showLoading
        && current
        && Number.isFinite(generatedAt)
        && now - lastFullLoadRef.current < 60_000
        && Math.abs((current.to - current.from) - span) < 1_000
        && current.to >= from
        && current.to <= to
      );
      const requestFrom = incremental ? Math.max(from, generatedAt - 15_000) : from;
      const response = await loadTimeline(requestFrom, to, 900);
      const next = incremental && current ? mergeTimelineResponses(current, response, from, to) : { ...response, from, to };
      if (!incremental) lastFullLoadRef.current = now;
      dataRef.current = next;
      setData(next);
      onLatestSample?.(next.latest);
      setError("");
    } catch (requestError) {
      setError((requestError as Error).message || "Timeline data is unavailable");
    } finally {
      setLoading(false);
    }
  }, [historicalTo, live, loadTimeline, onLatestSample, span]);

  useEffect(() => () => onLatestSample?.(undefined), [onLatestSample]);

  useEffect(() => {
    void refresh(true);
    if (!live) return;
    const interval = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [live, refresh]);

  const markers = useMemo(() => timelineMarkers(data), [data]);
  const clusters = useMemo(() => clusterTimelineMarkers(markers, data?.from ?? 0, data?.to ?? 0), [data?.from, data?.to, markers]);
  const chartData = useMemo<ServerTimelineResourcePoint[]>(() => data?.samples.length ? data.samples : [
    { sampledAt: data?.from ?? Date.now() - span, available: false, running: false, cpuPercent: null, memoryUsageBytes: null, memoryLimitBytes: null, networkRxBytesPerSecond: null, networkTxBytesPerSecond: null },
    { sampledAt: data?.to ?? Date.now(), available: false, running: false, cpuPercent: null, memoryUsageBytes: null, memoryLimitBytes: null, networkRxBytesPerSecond: null, networkTxBytesPerSecond: null }
  ], [data, span]);
  const chartFrom = data?.from ?? Date.now() - span;
  const chartTo = data?.to ?? Date.now();
  const resourceState = useMemo(() => {
    if (!data?.samples.length) return "empty";
    const available = data.samples.filter((point) => point.available && point.running && point.cpuPercent !== null && point.memoryUsageBytes !== null).length;
    if (available === 0) return "unavailable";
    if (available < data.samples.length) return "partial";
    return "available";
  }, [data]);

  const activateCluster = (cluster: MarkerCluster) => {
    const schedule = cluster.markers.find((marker) => marker.schedule)?.schedule;
    if (!schedule) {
      onOpenConsole();
      return;
    }
    if (schedule.kind === "run" && schedule.runId) onOpenSchedules({ kind: "completed-run", scheduleId: schedule.scheduleId, runId: schedule.runId });
    else if (schedule.kind === "active" && schedule.runId) onOpenSchedules({ kind: "active-run", scheduleId: schedule.scheduleId, runId: schedule.runId });
    else onOpenSchedules({ kind: "schedule", scheduleId: schedule.scheduleId });
  };

  const pan = (direction: -1 | 1) => {
    const currentTo = data?.to ?? Date.now() + span * 0.1;
    const liveBoundary = Date.now() + span * 0.1;
    const nextTo = Math.min(liveBoundary, currentTo + direction * span * 0.5);
    if (direction === 1 && nextTo >= liveBoundary - 1_000) {
      setHistoricalTo(null);
      setLive(true);
      return;
    }
    setHistoricalTo(nextTo);
    setLive(false);
  };

  const jumpToNow = () => {
    setHistoricalTo(null);
    setLive(true);
  };

  return (
    <section className="panel serverTimelinePanel" aria-busy={loading}>
      <PanelHeader
        title="Server Timeline"
        description="Correlate resource usage with player activity, server events, and schedules."
        actions={<div className="serverTimelineRangeControls" role="group" aria-label="Timeline range">
          <Button variant="ghost" compact className={live ? "active" : ""} onClick={jumpToNow} aria-pressed={live}>Live</Button>
          {timelineRanges.map((candidate) => (
            <Button
              variant="ghost"
              compact
              key={candidate.label}
              className={range === candidate.label ? "active" : ""}
              onClick={() => { setRange(candidate.label); setHistoricalTo(null); setLive(true); }}
              aria-pressed={range === candidate.label}
            >{candidate.label}</Button>
          ))}
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
          <span className="timelineAnnotationLegend tone-join">Player joins</span>
          <span className="timelineAnnotationLegend tone-leave">Player leaves</span>
          <span className="timelineAnnotationLegend tone-server">Server events</span>
          {data?.scheduleAnnotationsAvailable && <span className="timelineAnnotationLegend tone-schedule">Schedules</span>}
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
      <div className="serverTimelineChart" role="img" aria-label="Server resource and event timeline">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 48, right: 96, bottom: 12, left: 6 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis type="number" dataKey="sampledAt" domain={[chartFrom, chartTo]} allowDataOverflow tickFormatter={(value) => formatTime(Number(value))} minTickGap={56} tickLine={false} axisLine tickMargin={10} />
            <YAxis yAxisId="cpu" orientation="left" width={54} tickFormatter={(value) => `${Number(value).toFixed(0)}%`} tickLine={false} axisLine domain={[0, "auto"]} />
            <YAxis yAxisId="memory" orientation="right" width={68} tickFormatter={(value) => formatBytes(Number(value))} tickLine={false} axisLine domain={[0, "auto"]} />
            <YAxis yAxisId="network" orientation="right" width={74} tickFormatter={(value) => formatRate(Number(value))} tickLine={false} axisLine={false} domain={[0, "auto"]} />
            <Tooltip content={(props) => <TimelineTooltip {...props} clusters={clusters} span={span} formatDate={formatDate} />} isAnimationActive={false} />
            {enabled.cpuPercent && <Line yAxisId="cpu" type="monotone" dataKey="cpuPercent" name="CPU" stroke="var(--timeline-cpu)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />}
            {enabled.memoryUsageBytes && <Line yAxisId="memory" type="monotone" dataKey="memoryUsageBytes" name="Memory" stroke="var(--timeline-memory)" strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />}
            {enabled.networkRxBytesPerSecond && <Line yAxisId="network" type="monotone" dataKey="networkRxBytesPerSecond" name="Network In" stroke="var(--timeline-network-in)" strokeWidth={1.8} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />}
            {enabled.networkTxBytesPerSecond && <Line yAxisId="network" type="monotone" dataKey="networkTxBytesPerSecond" name="Network Out" stroke="var(--timeline-network-out)" strokeWidth={1.8} dot={false} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />}
            {clusters.map((cluster) => (
              <ReferenceLine
                key={cluster.id}
                x={cluster.occurredAt}
                yAxisId="cpu"
                stroke={`var(--timeline-${cluster.tone})`}
                strokeDasharray="3 3"
                label={(props: unknown) => <AnnotationLabel props={props} cluster={cluster} formatDate={formatDate} onActivate={() => activateCluster(cluster)} />}
              />
            ))}
            {Date.now() >= chartFrom && Date.now() <= chartTo && <ReferenceLine x={Date.now()} yAxisId="cpu" stroke="var(--accent)" strokeDasharray="2 3" label={{ value: "Now", position: "top", fill: "var(--text-muted)", fontSize: 11 }} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      {!loading && !data?.samples.length && !markers.length && <div className="serverTimelineEmpty">No timeline data is available for this window.</div>}
    </section>
  );
}
