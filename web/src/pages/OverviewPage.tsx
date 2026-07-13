import { useEffect, useMemo, useState } from 'react';
import type { ManagedServer, ServerActivity, ServerEvent, ServerStatus } from '../types';
import { formatActivityDate, formatUptime } from '../utils/resourceFormatting';
import { fabricLoaderVersionInfo, minecraftVersionInfo, runtimeLabel, runtimeTone, versionValue } from '../utils/format';
import { Button, EmptyState, LoadingLabel, PanelHeader, SkeletonBlock } from '../components/UiPrimitives';
import type { RequestConfirmation } from '../components/ConfirmationModal';

const hiddenRecentEventsKey = 'serversentinel-hidden-recent-event-signatures';

function dockerStateLabel(status: ServerStatus | null, dockerSocketMounted: boolean) {
  if (!dockerSocketMounted) return "Unavailable";
  if (!status) return "Unknown";
  if (!status.docker.configured) return "Unconfigured";
  if (!status.docker.available) return "Unavailable";
  if (status.docker.running) return "Running";
  if (status.docker.state === "created") return "Created";
  if (status.docker.state === "restarting") return "Restarting";
  if (status.docker.state === "paused") return "Paused";
  if (status.docker.state === "dead") return "Crashed";
  if (status.docker.state === "exited") return "Stopped";
  if (status.docker.state === "removing") return "Stopping";
  return "Unknown";
}

function summaryTone(status: ServerStatus | null, dockerSocketMounted: boolean) {
  if (!dockerSocketMounted || !status || !status.docker.available || !status.docker.configured) return "neutral";
  if (status.docker.running) return "running";
  if (status.docker.state === "dead") return "danger";
  return "stopped";
}

export function OverviewSummary({
  server,
  status,
  dockerSocketMounted,
  activity,
  loading = false
}: {
  server: ManagedServer;
  status: ServerStatus | null;
  dockerSocketMounted: boolean;
  activity: ServerActivity;
  loading?: boolean;
}) {
  const running = Boolean(status?.docker.running);
  const state = dockerStateLabel(status, dockerSocketMounted);
  const players = activity.playersOnline === null || activity.playersOnline === undefined
    ? "Unknown"
    : activity.maxPlayers
      ? `${activity.playersOnline} / ${activity.maxPlayers}`
      : String(activity.playersOnline);
  const minecraftVersion = minecraftVersionInfo(server);
  const fabricLoaderVersion = fabricLoaderVersionInfo(server);
  return (
    <section className="overviewSummary" aria-busy={loading}>
      {loading && <LoadingLabel>Loading server summary</LoadingLabel>}
      <div className={`summaryTile state ${summaryTone(status, dockerSocketMounted)}`}>
        <span>Status</span>
        <strong className="summaryStatusText">{loading ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : state}</strong>
      </div>
      <div className="summaryTile">
        <span>Minecraft</span>
        <strong>{loading ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : versionValue(minecraftVersion)}</strong>
      </div>
      <div className="summaryTile">
        <span>Fabric</span>
        <strong>{loading ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : versionValue(fabricLoaderVersion)}</strong>
      </div>
      <div className="summaryTile">
        <span>Uptime</span>
        <strong>{loading ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : running ? formatUptime(activity.lastStartedAt, running) : "Not running"}</strong>
      </div>
      <div className="summaryTile">
        <span>Players</span>
        <strong>{loading ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : players}</strong>
      </div>
      <div className={`summaryTile ${runtimeTone(status, dockerSocketMounted)}`}>
        <span>Container</span>
        <strong>{loading ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : runtimeLabel(status, dockerSocketMounted).replace(/^Container /, "")}</strong>
      </div>
    </section>
  );
}

export function ActivityHealthPanel({ activity, formatDate, loading = false }: { activity: ServerActivity; formatDate: (value: string | number | Date) => string; loading?: boolean }) {
  const items = [
    ["Last started", formatActivityDate(activity.lastStartedAt, formatDate)],
    ["Last stopped", formatActivityDate(activity.lastStoppedAt, formatDate)],
    ["Current world", activity.currentWorld || "Unknown"],
    ["Server port", activity.serverPort || "Unknown"],
    ["EULA accepted", activity.eulaAccepted === undefined ? "Unknown" : activity.eulaAccepted ? "Yes" : "No"],
    ["Java", activity.javaRuntime || "Unknown"]
  ];
  return (
    <section className="panel activityPanel" aria-busy={loading}>
      <PanelHeader title="Server Activity & Health" />
      {loading && <LoadingLabel>Loading server activity and health</LoadingLabel>}
      <div className="activityGrid">
        {items.map(([label, value]) => (
          <div className="activityItem" key={label}>
            <span>{label}</span>
            <strong>{loading ? <SkeletonBlock className="activityValueSkeleton" /> : value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

export function eventDate(value: string | undefined, now = new Date()) {
  if (!value) return null;
  const timeOnly = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (timeOnly) {
    const date = new Date(now);
    date.setHours(Number(timeOnly[1]), Number(timeOnly[2]), Number(timeOnly[3]), 0);
    // Log lines without a date refer to the latest occurrence of that clock time.
    if (date.getTime() > now.getTime()) date.setDate(date.getDate() - 1);
    return date;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatRelativeEventTime(value: string | undefined, now = new Date()) {
  const date = eventDate(value, now);
  if (!date) return value ? "Unknown" : "No timestamp";
  const elapsedSeconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (elapsedSeconds < 60) return "Just now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export function RecentEventsPanel({
  events,
  eventsStatus = "ok",
  formatDate,
  onOpenConsole,
  requestConfirmation,
  loading = false
}: {
  events: ServerEvent[];
  eventsStatus?: "ok" | "unavailable";
  formatDate: (value: string | number | Date) => string;
  onOpenConsole: () => void;
  requestConfirmation: RequestConfirmation;
  loading?: boolean;
}) {
  const [hiddenSignatures, setHiddenSignatures] = useState<string[]>(() => {
    try {
      const stored = window.localStorage.getItem(hiddenRecentEventsKey);
      const parsed = stored ? JSON.parse(stored) : [];
      return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
    } catch {
      return [];
    }
  });
  const [now, setNow] = useState(() => new Date());
  const hiddenSignatureSet = useMemo(() => new Set(hiddenSignatures), [hiddenSignatures]);
  const visibleEvents = useMemo(
    () => events.filter((event) => !hiddenSignatureSet.has(event.signature)),
    [events, hiddenSignatureSet]
  );
  const displayEvents = visibleEvents.slice(0, 8);
  const hasHiddenEvents = events.some((event) => hiddenSignatureSet.has(event.signature));

  useEffect(() => {
    try {
      window.localStorage.setItem(hiddenRecentEventsKey, JSON.stringify(hiddenSignatures));
    } catch {
      // Ignore unavailable browser storage; hidden events remain hidden for this session.
    }
  }, [hiddenSignatures]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  function hideEvent(signature: string) {
    setHiddenSignatures((current) => current.includes(signature) ? current : [...current, signature]);
  }

  async function confirmHideEvent(event: ServerEvent) {
    const confirmed = await requestConfirmation({
      title: "Hide event type?",
      description: "Hide all recent events matching this type.",
      details: event.text,
      warning: "You can restore hidden event types with Reset hidden events.",
      warningTone: "warning",
      confirmLabel: "Hide events",
      variant: "critical"
    });
    if (confirmed) hideEvent(event.signature);
  }

  return (
    <section className="panel eventsPanel" aria-busy={loading}>
      <PanelHeader
        title="Recent Events"
        actions={hiddenSignatures.length > 0 && (
          <Button variant="ghost" compact className="textLinkButton" onClick={() => setHiddenSignatures([])}>
            Reset hidden events
          </Button>
        )}
      />
      <div className="eventList">
        {loading && <LoadingLabel>Loading recent events</LoadingLabel>}
        {loading ? Array.from({ length: 5 }, (_, index) => (
          <div className="eventRow eventSkeletonRow" key={index} aria-hidden="true">
            <SkeletonBlock className="eventMarkerSkeleton" />
            <SkeletonBlock className="eventTextSkeleton" />
            <SkeletonBlock className="eventTimeSkeleton" />
          </div>
        )) : displayEvents.length ? displayEvents.map((event) => (
          <div className={`eventRow ${event.type}`} key={event.id}>
            <span className="eventMarker" aria-hidden="true" />
            <strong>{event.text}</strong>
            <small title={eventDate(event.timestamp, now) ? formatDate(eventDate(event.timestamp, now)!) : undefined}>
              {formatRelativeEventTime(event.timestamp, now)}
            </small>
            <Button
              variant="ghost"
              iconOnly
              className="eventHideButton"
              onClick={() => void confirmHideEvent(event)}
              aria-label="Hide events of this type"
            >
              <svg viewBox="0 0 24 24" className="buttonIcon" aria-hidden="true">
                <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                <path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                <line x1="2" y1="2" x2="22" y2="22" />
              </svg>
            </Button>
          </div>
        )) : (
          <EmptyState
            compact
            className="eventEmpty"
            title={hasHiddenEvents ? "Recent events are hidden" : eventsStatus === "unavailable" ? "Events are unavailable" : "No recent events yet"}
            message={(hasHiddenEvents || eventsStatus === "unavailable") ? (
              <>
                {hasHiddenEvents
                  ? "Reset hidden events to show them again."
                  : "Open the console to inspect raw logs, or try again after the server writes new output."}
              </>
            ) : undefined}
          />
        )}
      </div>
      <Button variant="ghost" compact className="textLinkButton eventLogButton" onClick={onOpenConsole}>View full log</Button>

    </section>
  );
}
