import type { ManagedServer, ServerActivity, ServerEvent, ServerStatus } from '../types';
import { formatActivityDate, formatUptime } from '../components/ResourcePanel';
import { runtimeLabel, runtimeTone } from '../utils/format';

export function OverviewSummary({
  server,
  status,
  dockerSocketMounted,
  activity,
  formatDate
}: {
  server: ManagedServer;
  status: ServerStatus | null;
  dockerSocketMounted: boolean;
  activity: ServerActivity;
  formatDate: (value: string | number | Date) => string;
}) {
  const running = Boolean(status?.docker.running);
  const state = running ? "Running" : status?.docker.state === "unknown" ? "Unknown" : "Stopped";
  const players = activity.playersOnline === null || activity.playersOnline === undefined
    ? "Unknown"
    : activity.maxPlayers
      ? `${activity.playersOnline} / ${activity.maxPlayers}`
      : String(activity.playersOnline);
  return (
    <section className="overviewSummary">
      <div className={`summaryTile state ${running ? "running" : "stopped"}`}>
        <span>State</span>
        <strong>{state}</strong>
        <small>{running ? `Since ${formatActivityDate(activity.lastStartedAt, formatDate)}` : status?.docker.message || "Not currently running"}</small>
      </div>
      <div className="summaryTile">
        <span>Minecraft version</span>
        <strong>{server.minecraftVersion || "Unknown"}</strong>
        <small>Release</small>
      </div>
      <div className="summaryTile">
        <span>Fabric loader</span>
        <strong>{server.loaderVersion || "Unknown"}</strong>
        <small>{server.loaderVersion ? "Configured" : "Latest stable may be used"}</small>
      </div>
      <div className="summaryTile">
        <span>Uptime</span>
        <strong>{formatUptime(activity.lastStartedAt, running)}</strong>
        <small>{running ? "Container start time" : "Unavailable while stopped"}</small>
      </div>
      <div className="summaryTile">
        <span>Players online</span>
        <strong>{players}</strong>
        <small>{activity.maxPlayers ? "Max players" : "From recent server output"}</small>
      </div>
      <div className={`summaryTile ${runtimeTone(status, dockerSocketMounted)}`}>
        <span>Runtime status</span>
        <strong>{runtimeLabel(status, dockerSocketMounted).replace(/^Container /, "")}</strong>
        <small>{status?.docker.container || "Container unavailable"}</small>
      </div>
    </section>
  );
}

export function ActivityHealthPanel({ activity, formatDate }: { activity: ServerActivity; formatDate: (value: string | number | Date) => string }) {
  const items = [
    ["Last started", formatActivityDate(activity.lastStartedAt, formatDate)],
    ["Last restart", formatActivityDate(activity.lastRestartAt, formatDate)],
    ["Last stopped", formatActivityDate(activity.lastStoppedAt, formatDate)],
    ["Current world", activity.currentWorld || "Unknown"],
    ["Server port", activity.serverPort || "Unknown"],
    ["EULA accepted", activity.eulaAccepted === undefined ? "Unknown" : activity.eulaAccepted ? "Yes" : "No"],
    ["Java", activity.javaRuntime || "Unknown"],
    ["Autosave", activity.autosaveStatus || "Unavailable"]
  ];
  return (
    <section className="panel activityPanel">
      <div className="panelHeader">
        <h2>Server Activity &amp; Health</h2>
      </div>
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

export function RecentEventsPanel({ events, onOpenConsole }: { events: ServerEvent[]; onOpenConsole: () => void }) {
  return (
    <section className="panel eventsPanel">
      <div className="panelHeader">
        <h2>Recent Events</h2>
      </div>
      <div className="eventList">
        {events.length ? events.map((event) => (
          <div className={`eventRow ${event.type}`} key={event.id}>
            <span className="eventMarker" aria-hidden="true" />
            <strong>{event.text}</strong>
            <small>{event.timestamp || event.source}</small>
          </div>
        )) : (
          <div className="eventEmpty">No recent server events found.</div>
        )}
      </div>
      <button type="button" className="textLinkButton" onClick={onOpenConsole}>View full log</button>
    </section>
  );
}
