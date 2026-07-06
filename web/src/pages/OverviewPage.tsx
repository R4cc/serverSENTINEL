import { useEffect, useMemo, useState } from 'react';
import type { ManagedServer, ServerActivity, ServerEvent, ServerStatus } from '../types';
import { formatActivityDate, formatUptime } from '../components/ResourcePanel';
import { fabricLoaderVersionInfo, minecraftVersionInfo, runtimeLabel, runtimeTone, versionValue } from '../utils/format';
import { AppIcon } from '../components/FileTypeIcon';
import { Button, EmptyState, PanelHeader } from '../components/UiPrimitives';

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
  activity
}: {
  server: ManagedServer;
  status: ServerStatus | null;
  dockerSocketMounted: boolean;
  activity: ServerActivity;
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
  const runtimeProfile = server.runtimeProfile;
  return (
    <section className="overviewSummary">
      <div className={`summaryTile state ${summaryTone(status, dockerSocketMounted)}`}>
        <span>Status</span>
        <strong className="summaryStatusText">{state}</strong>
      </div>
      <div className="summaryTile">
        <span>Minecraft</span>
        <strong>{versionValue(minecraftVersion)}</strong>
      </div>
      <div className="summaryTile">
        <span>Fabric</span>
        <strong>{versionValue(fabricLoaderVersion)}</strong>
      </div>
      <div className="summaryTile">
        <span>Runtime</span>
        <strong>{`${runtimeProfile.minecraftVersion} Fabric`}</strong>
      </div>
      <div className="summaryTile">
        <span>Uptime</span>
        <strong>{running ? formatUptime(activity.lastStartedAt, running) : "Not running"}</strong>
      </div>
      <div className="summaryTile">
        <span>Players</span>
        <strong>{players}</strong>
      </div>
      <div className={`summaryTile ${runtimeTone(status, dockerSocketMounted)}`}>
        <span>Container</span>
        <strong>{runtimeLabel(status, dockerSocketMounted).replace(/^Container /, "")}</strong>
      </div>
    </section>
  );
}

export function ActivityHealthPanel({ activity, formatDate }: { activity: ServerActivity; formatDate: (value: string | number | Date) => string }) {
  const items = [
    ["Last started", formatActivityDate(activity.lastStartedAt, formatDate)],
    ["Last stopped", formatActivityDate(activity.lastStoppedAt, formatDate)],
    ["Current world", activity.currentWorld || "Unknown"],
    ["Server port", activity.serverPort || "Unknown"],
    ["EULA accepted", activity.eulaAccepted === undefined ? "Unknown" : activity.eulaAccepted ? "Yes" : "No"],
    ["Java", activity.javaRuntime || "Unknown"]
  ];
  return (
    <section className="panel activityPanel">
      <PanelHeader title="Server Activity & Health" />
      <div className="activityGrid">
        {items.map(([label, value]) => (
          <div className="activityItem" key={label}>
            <span>{label}</span>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function formatEventTimestamp(value: string | undefined, formatDate: (value: string | number | Date) => string) {
  if (!value) return "No timestamp";
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  return formatDate(date);
}

export function RecentEventsPanel({
  events,
  eventsStatus = "ok",
  formatDate,
  onOpenConsole
}: {
  events: ServerEvent[];
  eventsStatus?: "ok" | "unavailable";
  formatDate: (value: string | number | Date) => string;
  onOpenConsole: () => void;
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
  const [confirmHide, setConfirmHide] = useState<{ signature: string; text: string } | null>(null);
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

  function hideEvent(signature: string) {
    setHiddenSignatures((current) => current.includes(signature) ? current : [...current, signature]);
  }

  return (
    <section className="panel eventsPanel">
      <PanelHeader
        title="Recent Events"
        actions={hiddenSignatures.length > 0 && (
          <Button variant="ghost" compact className="textLinkButton" onClick={() => setHiddenSignatures([])}>
            Reset hidden events
          </Button>
        )}
      />
      <div className="eventList">
        {displayEvents.length ? displayEvents.map((event) => (
          <div className={`eventRow ${event.type}`} key={event.id}>
            <span className="eventMarker" aria-hidden="true" />
            <strong>{event.text}</strong>
            <small>{formatEventTimestamp(event.timestamp, formatDate)}</small>
            <Button
              variant="ghost"
              iconOnly
              className="eventHideButton"
              onClick={() => setConfirmHide({ signature: event.signature, text: event.text })}
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

      {confirmHide && (
        <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setConfirmHide(null);
        }}>
          <section className="modalPanel confirmModalPanel" role="dialog" aria-modal="true" aria-labelledby="confirm-hide-title">
            <header className="modalHeader">
              <h2 id="confirm-hide-title">Hide Event Type</h2>
              <Button variant="secondary" iconOnly className="iconButton modalCloseButton" onClick={() => setConfirmHide(null)} aria-label="Close dialog" title="Close dialog">
                <AppIcon name="x" />
              </Button>
            </header>
            <div className="modalBody confirmContent">
              <p>Hide all recent events matching this type?</p>
              <blockquote>
                <strong>{confirmHide.text}</strong>
              </blockquote>
            </div>
            <footer className="modalFooter">
              <Button variant="secondary" onClick={() => setConfirmHide(null)}>Cancel</Button>
              <Button variant="critical" onClick={() => {
                hideEvent(confirmHide.signature);
                setConfirmHide(null);
              }}>Hide Events</Button>
            </footer>
          </section>
        </div>
      )}
    </section>
  );
}
