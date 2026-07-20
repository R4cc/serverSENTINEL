import { useEffect, useMemo, useState } from 'react';
import type {
  ManagedServer,
  ModUpdatePlan,
  PlayerSnapshot,
  ScheduledExecution,
  ScheduleNavigationTarget,
  ServerActivity,
  ServerEvent,
  ServerStatus
} from '../types';
import { formatUptime } from '../utils/resourceFormatting';
import { serverRuntimeDefinition } from '@serversentinel/contracts';
import { formatRelativeTimestamp, minecraftVersionInfo, runtimeVersionInfo, versionValue } from '../utils/format';
import { Button, EmptyState, LoadingLabel, PanelHeader, SkeletonBlock, StatusBadge } from '../components/UiPrimitives';
import type { RequestConfirmation } from '../components/ConfirmationModal';
import { AppIcon } from '../components/FileTypeIcon';
import { EventIcon, type EventIconKind } from '../components/EventIcon';
import { ModIconImage } from '../features/mods/ModIconImage';
import { modIconSource } from '../utils/appHelpers';
import { groupNearbyRepeatedEvents, playerEventSubject, playerReconnectWindowMs, samePlayerName } from '../utils/serverEvents';

const hiddenRecentEventsKey = 'serversentinel-hidden-recent-event-signatures';
const modUpdateCardSlotCount = 3;
const upcomingScheduleDisplayLimit = 4;
const upcomingScheduleWindowMs = 24 * 60 * 60 * 1000;

function dockerStateLabel(status: ServerStatus | null, dockerSocketMounted: boolean) {
  if (!dockerSocketMounted) return "Unavailable";
  if (!status) return "Unknown";
  if (!status.docker.configured) return "Unconfigured";
  if (!status.docker.available) return "Unavailable";
  if (status.lifecycle.state === "crash-loop") return "Crash loop";
  if (status.lifecycle.state === "recovering") return `Recovering (${Math.min((status.lifecycle.recoveryAttempt ?? 0) + 1, 3)}/3)`;
  if (status.lifecycle.state === "stopping") return status.lifecycle.intent === "restarting" ? "Stopping for restart" : "Stopping";
  if (status.lifecycle.state === "starting") return "Starting after restart";
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
  if (status.lifecycle.state === "crash-loop") return "danger";
  if (["recovering", "stopping", "starting"].includes(status.lifecycle.state)) return "warning";
  if (status.docker.running) return "running";
  if (status.docker.state === "dead") return "danger";
  return "stopped";
}

export function OverviewSummary({
  server,
  status,
  dockerSocketMounted,
  activity,
  playerSnapshot,
  latestResourceSample,
  formatNumber = (value) => String(value),
  loading = false
}: {
  server: ManagedServer;
  status: ServerStatus | null;
  dockerSocketMounted: boolean;
  activity: ServerActivity;
  playerSnapshot?: PlayerSnapshot;
  latestResourceSample?: {
    available: boolean;
    running: boolean;
    cpuPercent: number | null;
    cpuUtilizationPercent?: number | null;
    cpuCapacityCores?: number;
    memoryUsageBytes: number | null;
  };
  formatNumber?: (value: number) => string;
  loading?: boolean;
}) {
  const running = Boolean(status?.docker.running);
  const state = dockerStateLabel(status, dockerSocketMounted);
  const players = !playerSnapshot
    ? "Collecting"
    : playerSnapshot.state === "stopped"
      ? "Not running"
      : playerSnapshot.state === "unavailable"
        ? "Unavailable"
        : playerSnapshot.maxPlayers
          ? `${playerSnapshot.online} / ${playerSnapshot.maxPlayers}`
          : String(playerSnapshot.online);
  const minecraftVersion = minecraftVersionInfo(server);
  const runtimeVersion = runtimeVersionInfo(server);
  const runtime = serverRuntimeDefinition(server.runtimeProfile.runtimeType);
  const hasResourceStats = Boolean(latestResourceSample?.available && latestResourceSample.running);
  const resourceFallback = running ? "Collecting" : "Not running";
  const normalizedCpu = latestResourceSample?.cpuUtilizationPercent
    ?? (latestResourceSample?.cpuCapacityCores && latestResourceSample.cpuPercent !== null
      ? latestResourceSample.cpuPercent / latestResourceSample.cpuCapacityCores
      : null);
  const cpu = hasResourceStats && normalizedCpu !== null ? `${normalizedCpu.toFixed(1)}%` : resourceFallback;
  const memory = hasResourceStats
    ? `${formatNumber(Math.round((latestResourceSample?.memoryUsageBytes ?? 0) / 1024 / 1024))} MB`
    : resourceFallback;

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
        <span>{runtime.displayName}</span>
        <strong>{loading ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : versionValue(runtimeVersion)}</strong>
      </div>
      <div className="summaryTile">
        <span>Uptime</span>
        <strong>{loading ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : running ? formatUptime(activity.lastStartedAt, running) : "Not running"}</strong>
      </div>
      <div className="summaryTile">
        <span>Players</span>
        <strong>{loading ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : players}</strong>
      </div>
      <div className="summaryTile overviewWideSummaryTile">
        <span>CPU</span>
        <strong>{loading ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : cpu}</strong>
      </div>
      <div className="summaryTile overviewWideSummaryTile">
        <span>Memory</span>
        <strong>{loading ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : memory}</strong>
      </div>
    </section>
  );
}

export function ActivePlayersPanel({
  snapshot,
  running,
  loading = false
}: {
  snapshot?: PlayerSnapshot;
  running: boolean;
  loading?: boolean;
}) {
  const available = snapshot?.state === "live" || snapshot?.state === "stale" ? snapshot : undefined;
  const online = available?.online;
  const countLabel = available
    ? available.maxPlayers ? `${available.online} / ${available.maxPlayers}` : String(available.online)
    : snapshot?.state === "stopped" ? "Stopped" : "Unavailable";

  let content;
  if (loading && !snapshot) {
    content = <div className="overviewPanelSkeleton" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <SkeletonBlock key={index} className="playerNameSkeleton" />)}</div>;
  } else if (!running || snapshot?.state === "stopped") {
    content = <EmptyState compact title="Server is not running" message="Player activity will appear after the server starts." />;
  } else if (!snapshot || snapshot.state === "unavailable") {
    content = <EmptyState compact title="Player query unavailable" message={snapshot?.message ?? "Waiting for the first complete player snapshot."} />;
  } else if (online === 0) {
    content = <EmptyState compact title="No players online" message="The server is ready for players." />;
  } else {
    content = (
      <div className="activePlayerRoster">
        <div className="activePlayerGrid">
          {snapshot.names.map((name) => (
            <div className="activePlayer" key={name}>
              <span className="activePlayerDot" aria-hidden="true" />
              <strong>{name}</strong>
            </div>
          ))}
        </div>
        {snapshot.state === "stale" && (
          <small className="activePlayerUpdatedAt">
            Updated {formatRelativeTimestamp(snapshot.sampledAt).toLocaleLowerCase()}
          </small>
        )}
      </div>
    );
  }

  return (
    <section className="panel playersPanel overviewOperationsPanel" aria-busy={loading}>
      <PanelHeader title="Active Players" actions={<StatusBadge tone={available?.state === "stale" ? "warning" : running && online ? "success" : "neutral"}>{countLabel}</StatusBadge>} />
      {loading && <LoadingLabel>Loading active players</LoadingLabel>}
      {content}
    </section>
  );
}

export function ModHealthPanel({
  updatePlan,
  loading = false,
  canView = true,
  onOpenMods,
  onRefresh,
  contentPlural = "mods",
  contentPluralTitle = "Mods"
}: {
  updatePlan: ModUpdatePlan | null;
  loading?: boolean;
  canView?: boolean;
  onOpenMods: () => void;
  onRefresh?: () => void;
  contentPlural?: "mods" | "plugins";
  contentPluralTitle?: "Mods" | "Plugins";
}) {
  if (!canView) return null;
  if (loading || !updatePlan) return <ModHealthPanelSkeleton contentPlural={contentPlural} contentPluralTitle={contentPluralTitle} />;
  const contentSingular = contentPlural === "plugins" ? "plugin" : "mod";
  const contentSingularTitle = contentPlural === "plugins" ? "Plugin" : "Mod";

  const updateCount = updatePlan.counts.safeUpdates + updatePlan.counts.reviewUpdates;
  const availableUpdates = updatePlan.updates.filter((entry) => entry.status === "safe_update" || entry.status === "needs_review");
  const visibleUpdates = availableUpdates.slice(0, modUpdateCardSlotCount);
  const remainingUpdates = Math.max(0, availableUpdates.length - visibleUpdates.length);
  if (updateCount === 0) {
    return (
      <section className="panel modsHealthPanel modUpdatesCard modUpdatesCard--healthy">
        <button
          type="button"
          className="modUpdatesCardOpen"
          onClick={onOpenMods}
          aria-label={`Open ${contentPluralTitle}, no ${contentSingular} updates available`}
        >
          <span className="modUpdatesCompact">
            <span className="modUpdatesHeaderCopy">
              <strong>{contentSingularTitle} updates</strong>
              <small>No updates available</small>
            </span>
            <strong><AppIcon name="check" /></strong>
          </span>
          <span className="modUpdatesWide" aria-hidden="true">
            <span className="modUpdatesWideHeader">
              <span className="modUpdatesHeaderCopy">
                <strong>{contentSingularTitle} updates</strong>
                <small>No updates available</small>
              </span>
              <AppIcon name="chevronRight" />
            </span>
            <span className="modUpdatesList">
              <span className="modUpdatesListItem modUpdatesListItem--healthy">
                <span className="modUpdatesHealthyIcon"><AppIcon name="check" /></span>
                <span className="modUpdatesListCopy">
                  <strong>Everything is up to date</strong>
                  <small><span>New {contentSingular} updates will appear here.</span></small>
                </span>
              </span>
            </span>
          </span>
        </button>
        <ModUpdatesRefreshButton contentPlural={contentPlural} onRefresh={onRefresh} />
      </section>
    );
  }

  return (
    <section className="panel modsHealthPanel modUpdatesCard">
      <button
        type="button"
        className="modUpdatesCardOpen"
        onClick={onOpenMods}
        aria-label={`Open ${contentPluralTitle}, ${updateCount} ${contentSingular} update${updateCount === 1 ? "" : "s"} available`}
      >
        <span className="modUpdatesCompact">
          <span className="modUpdatesHeaderCopy">
            <strong>{contentSingularTitle} updates</strong>
            <small>{updateCount} update{updateCount === 1 ? "" : "s"} available</small>
          </span>
          <strong>{updateCount}</strong>
        </span>
        <span className="modUpdatesWide" aria-hidden="true">
          <span className="modUpdatesWideHeader">
            <span className="modUpdatesHeaderCopy">
              <strong>{contentSingularTitle} updates</strong>
              <small>{updateCount} update{updateCount === 1 ? "" : "s"} available</small>
            </span>
            <AppIcon name="chevronRight" />
          </span>
          <span className="modUpdatesList">
            {visibleUpdates.map((entry) => (
              <span className="modUpdatesListItem" key={entry.filename}>
                <ModIconImage src={modIconSource(entry.iconUrl)} fallback="MOD" />
                <span className="modUpdatesListCopy">
                  <strong>{entry.displayName}</strong>
                  <small>
                    {entry.currentVersion && <span>{entry.currentVersion}</span>}
                    {entry.currentVersion && entry.targetVersion && <span aria-hidden="true">→</span>}
                    <span>{entry.targetVersion ?? "Update available"}</span>
                  </small>
                </span>
              </span>
            ))}
          </span>
          {remainingUpdates > 0 && <small className="modUpdatesRemaining">+{remainingUpdates} more update{remainingUpdates === 1 ? "" : "s"}</small>}
        </span>
      </button>
      <ModUpdatesRefreshButton contentPlural={contentPlural} onRefresh={onRefresh} />
    </section>
  );
}

function ModUpdatesRefreshButton({ contentPlural, onRefresh }: { contentPlural: "mods" | "plugins"; onRefresh?: () => void }) {
  if (!onRefresh) return null;
  const label = `Recheck ${contentPlural} for updates`;
  return (
    <Button variant="ghost" iconOnly compact className="modUpdatesRefreshButton" onClick={onRefresh} aria-label={label} title={label}>
      <AppIcon name="refresh" />
    </Button>
  );
}

function ModHealthPanelSkeleton({ contentPlural = "mods" }: { contentPlural?: "mods" | "plugins"; contentPluralTitle?: "Mods" | "Plugins" }) {
  const contentSingular = contentPlural === "plugins" ? "plugin" : "mod";
  const contentSingularTitle = contentPlural === "plugins" ? "Plugin" : "Mod";
  return (
    <section className="panel modsHealthPanel modUpdatesCard modUpdatesCardSkeleton" aria-busy="true">
      <LoadingLabel>Loading {contentSingular} updates</LoadingLabel>
      <span className="modUpdatesCompact" aria-hidden="true">
        <span className="modUpdatesHeaderCopy">
          <strong>{contentSingularTitle} updates</strong>
          <small>Checking for updates</small>
        </span>
        <SkeletonBlock className="modUpdatesCountSkeleton" />
      </span>
      <span className="modUpdatesWide modUpdatesWideSkeleton" aria-hidden="true">
        <span className="modUpdatesWideHeader">
          <span className="modUpdatesHeaderCopy">
            <strong>{contentSingularTitle} updates</strong>
            <small>Checking for updates</small>
          </span>
          <SkeletonBlock className="modUpdatesChevronSkeleton" />
        </span>
        <span className="modUpdatesList">
          {Array.from({ length: modUpdateCardSlotCount }, (_, index) => (
            <span className="modUpdatesListItem" key={index}>
              <SkeletonBlock className="modUpdatesIconSkeleton" />
              <span className="modUpdatesListCopy">
                <SkeletonBlock className="modUpdatesNameSkeleton" />
                <SkeletonBlock className="modUpdatesVersionSkeleton" />
              </span>
            </span>
          ))}
        </span>
      </span>
    </section>
  );
}

export type UpcomingScheduleSnapshot = {
  schedules: ScheduledExecution[];
  remainingInNext24Hours: number;
};

export function buildUpcomingScheduleSnapshot(schedules: ScheduledExecution[], now = new Date()): UpcomingScheduleSnapshot {
  const nowTime = now.getTime();
  const futureSchedules = schedules
    .filter((schedule) => {
      if (!schedule.enabled || !schedule.nextRunAt) return false;
      const nextRunTime = new Date(schedule.nextRunAt).getTime();
      return Number.isFinite(nextRunTime) && nextRunTime > nowTime;
    })
    .sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime());
  const schedulesInNext24Hours = futureSchedules.filter((schedule) => (
    new Date(schedule.nextRunAt!).getTime() <= nowTime + upcomingScheduleWindowMs
  ));
  const visibleSchedules = schedulesInNext24Hours.length > 0
    ? schedulesInNext24Hours.slice(0, upcomingScheduleDisplayLimit)
    : futureSchedules.slice(0, 1);

  return {
    schedules: visibleSchedules,
    remainingInNext24Hours: Math.max(0, schedulesInNext24Hours.length - visibleSchedules.length)
  };
}

export function formatRelativeScheduleTime(value: string, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const diffMs = date.getTime() - now.getTime();
  const minutes = Math.max(1, Math.round(Math.abs(diffMs) / 60_000));
  const label = minutes >= 1_440 ? `${Math.round(minutes / 1_440)}d` : minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`;
  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

export function SchedulePanel({
  schedules,
  canView = true,
  formatDate,
  relativeTimestamps = true,
  onOpenSchedules
}: {
  schedules: ScheduledExecution[];
  canView?: boolean;
  formatDate: (value: string | number | Date) => string;
  relativeTimestamps?: boolean;
  onOpenSchedules: (target?: ScheduleNavigationTarget) => void;
}) {
  const snapshot = buildUpcomingScheduleSnapshot(schedules);
  return (
    <section className="panel schedulePanel overviewOperationsPanel">
      <PanelHeader
        title="Schedule"
        actions={canView && <Button variant="ghost" compact className="textLinkButton" onClick={() => onOpenSchedules()}>Open Schedules</Button>}
      />
      {!canView ? (
        <EmptyState compact title="Schedules unavailable" message="View schedules permission is required." />
      ) : schedules.length === 0 ? (
        <EmptyState compact title="No schedules configured" message="Create recurring console actions from Schedules." />
      ) : snapshot.schedules.length === 0 ? (
        <EmptyState compact title="No upcoming schedules" message="Enabled schedules will appear here when their next run is planned." />
      ) : (
        <div className="scheduleUpcoming">
          <span className="scheduleUpcomingLabel">Next up</span>
          <div className="scheduleUpcomingList">
            {snapshot.schedules.map((schedule) => {
              const nextRunAt = schedule.nextRunAt!;
              const nextTime = relativeTimestamps ? formatRelativeScheduleTime(nextRunAt) : formatDate(nextRunAt);
              return (
                <button
                  key={schedule.id}
                  type="button"
                  className="scheduleUpcomingItem"
                  onClick={() => onOpenSchedules({ kind: "schedule", scheduleId: schedule.id })}
                  aria-label={`Open ${schedule.name}, next run ${nextTime}`}
                >
                  <strong>{schedule.name}</strong>
                  <time dateTime={nextRunAt} title={relativeTimestamps ? formatDate(nextRunAt) : undefined}>{nextTime}</time>
                  <AppIcon name="chevronRight" />
                </button>
              );
            })}
          </div>
          {snapshot.remainingInNext24Hours > 0 && (
            <button
              type="button"
              className="scheduleUpcomingMore"
              onClick={() => onOpenSchedules()}
            >
              {snapshot.remainingInNext24Hours} more {snapshot.remainingInNext24Hours === 1 ? "schedule" : "schedules"} in the next 24 hours
            </button>
          )}
        </div>
      )}
    </section>
  );
}

export function eventDate(value: string | undefined, now = new Date()) {
  if (!value) return null;
  const timeOnly = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (timeOnly) {
    const date = new Date(now);
    date.setHours(Number(timeOnly[1]), Number(timeOnly[2]), Number(timeOnly[3]), 0);
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

type RecentEventKind = EventIconKind;

export type RecentEventGroup = {
  id: string;
  kind: RecentEventKind;
  severity: ServerEvent["severity"];
  title: string;
  details?: string;
  timestamp?: string;
  events: ServerEvent[];
};

export type RecentEventTimeSection = {
  id: "just-now" | "last-hour" | "earlier";
  label: "Just now" | "Within the last hour" | "Earlier";
  events: RecentEventGroup[];
};

function eventSubject(event: ServerEvent) {
  return playerEventSubject(event);
}

function secondsBetween(first: ServerEvent, second: ServerEvent, now: Date) {
  const firstDate = eventDate(first.timestamp, now);
  const secondDate = eventDate(second.timestamp, now);
  if (!firstDate || !secondDate) return null;
  return Math.abs(firstDate.getTime() - secondDate.getTime()) / 1000;
}

function defaultEventDetails(event: ServerEvent) {
  if (event.details) return event.details;
  if (event.eventType === "player_joined") return "Connected to the server";
  if (event.eventType === "player_left") return event.severity === "warning" ? "The connection was lost" : "Disconnected from the server";
  if (event.eventType === "server_started") return "Ready for players";
  if (event.eventType === "server_stopped") return "No longer accepting connections";
  if (event.eventType === "mod_disabled") return "Review the mod configuration before the next restart";
  if (event.eventType === "server_crashed") return "Open the console or crash reports for the cause";
  return undefined;
}

export function groupRecentEvents(events: ServerEvent[], now = new Date()): RecentEventGroup[] {
  const groups: RecentEventGroup[] = [];
  const repeatedGroups = groupNearbyRepeatedEvents(events, (event) => eventDate(event.timestamp, now)?.getTime() ?? null);

  for (let index = 0; index < repeatedGroups.length; index += 1) {
    const repeated = repeatedGroups[index];
    const event = repeated[0];
    const nextGroup = repeatedGroups[index + 1];
    const next = nextGroup?.length === 1 ? nextGroup[0] : undefined;
    const duration = next ? secondsBetween(event, next, now) : null;

    if (repeated.length > 1) {
      groups.push({
        id: repeated.map((item) => item.id).join(":"),
        kind: event.eventType,
        severity: event.severity,
        title: event.text,
        details: defaultEventDetails(event),
        timestamp: event.timestamp,
        events: repeated
      });
      continue;
    }

    if (
      event.eventType === "player_joined"
      && next?.eventType === "player_left"
      && samePlayerName(eventSubject(event), eventSubject(next))
      && duration !== null
      && duration * 1_000 <= playerReconnectWindowMs
    ) {
      const player = eventSubject(event);
      groups.push({
        id: `${event.id}:${next.id}`,
        kind: "player_reconnected",
        severity: "success",
        title: `${player} reconnected`,
        details: duration < 2 ? "Offline only momentarily" : `Offline for ${Math.round(duration)} seconds`,
        timestamp: event.timestamp,
        events: [event, next]
      });
      index += 1;
      continue;
    }

    if (
      event.eventType === "server_started"
      && next?.eventType === "server_stopped"
      && duration !== null
      && duration <= 5 * 60
    ) {
      groups.push({
        id: `${event.id}:${next.id}`,
        kind: "server_restarted",
        severity: "success",
        title: "Server restarted",
        details: duration < 2 ? "Stopped and started again" : `Back online after ${Math.round(duration)} seconds`,
        timestamp: event.timestamp,
        events: [event, next]
      });
      index += 1;
      continue;
    }

    groups.push({
      id: event.id,
      kind: event.eventType,
      severity: event.severity,
      title: event.text,
      details: defaultEventDetails(event),
      timestamp: event.timestamp,
      events: [event]
    });
  }

  return groups;
}

export function groupRecentEventsByTime(groups: RecentEventGroup[], now = new Date()): RecentEventTimeSection[] {
  const sections: RecentEventTimeSection[] = [
    { id: "just-now", label: "Just now", events: [] },
    { id: "last-hour", label: "Within the last hour", events: [] },
    { id: "earlier", label: "Earlier", events: [] }
  ];

  for (const group of groups) {
    const timestamp = eventDate(group.timestamp, now);
    const elapsedMinutes = timestamp ? Math.max(0, (now.getTime() - timestamp.getTime()) / 60_000) : Number.POSITIVE_INFINITY;
    const section = elapsedMinutes < 15 ? sections[0] : elapsedMinutes < 60 ? sections[1] : sections[2];
    section.events.push(group);
  }

  return sections.filter((section) => section.events.length > 0);
}

export function recentEventPresentation(group: RecentEventGroup) {
  const playerEvent = group.events[0];
  const player = eventSubject(playerEvent) || group.title.replace(/\s+(?:joined|left|reconnected)$/i, "").trim();
  if (group.kind === "player_joined") {
    return { title: "Joined", subject: player, details: playerEvent.details };
  }
  if (group.kind === "player_left") {
    return {
      title: "Left",
      subject: player,
      details: playerEvent.details || (group.severity === "warning" ? "The connection was lost" : undefined)
    };
  }
  if (group.kind === "player_reconnected") {
    return { title: "Reconnected", subject: player, details: group.details };
  }
  return { title: group.title, subject: undefined, details: group.details };
}

function relatedEventLabel(group: RecentEventGroup) {
  if (group.events.length < 2) return null;
  return group.kind === "player_reconnected" || group.kind === "server_restarted"
    ? `${group.events.length} related events`
    : null;
}

export function RecentEventsPanel({
  events,
  eventsStatus = "ok",
  formatDate,
  relativeTimestamps = true,
  onOpenConsole,
  requestConfirmation,
  loading = false
}: {
  events: ServerEvent[];
  eventsStatus?: "ok" | "unavailable";
  formatDate: (value: string | number | Date) => string;
  relativeTimestamps?: boolean;
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
  const visibleEvents = useMemo(() => events.filter((event) => !hiddenSignatureSet.has(event.signature)), [events, hiddenSignatureSet]);
  const displayEvents = useMemo(() => groupRecentEvents(visibleEvents, now).slice(0, 8), [visibleEvents, now]);
  const eventSections = useMemo(() => groupRecentEventsByTime(displayEvents, now), [displayEvents, now]);
  const hasHiddenEvents = events.some((event) => hiddenSignatureSet.has(event.signature));

  useEffect(() => {
    try {
      window.localStorage.setItem(hiddenRecentEventsKey, JSON.stringify(hiddenSignatures));
    } catch {
      // Hidden event preferences remain available for this session.
    }
  }, [hiddenSignatures]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  async function confirmHideEvent(group: RecentEventGroup) {
    const signatures = Array.from(new Set(group.events.map((event) => event.signature)));
    const confirmed = await requestConfirmation({
      title: "Hide matching events?",
      description: "Hide recent events matching this entry.",
      details: group.title,
      warning: "You can restore hidden event types with Reset hidden events.",
      warningTone: "warning",
      confirmLabel: "Hide events",
      variant: "critical"
    });
    if (confirmed) setHiddenSignatures((current) => Array.from(new Set([...current, ...signatures])));
  }

  return (
    <section className="panel eventsPanel" aria-busy={loading}>
      <PanelHeader
        title="Recent Events"
        actions={hiddenSignatures.length > 0 && <Button variant="ghost" compact className="textLinkButton" onClick={() => setHiddenSignatures([])}>Reset hidden events</Button>}
      />
      <div className="eventList">
        {loading && <LoadingLabel>Loading recent events</LoadingLabel>}
        {loading ? Array.from({ length: 5 }, (_, index) => (
          <div className="eventRow eventSkeletonRow" key={index} aria-hidden="true">
            <SkeletonBlock className="eventMarkerSkeleton" />
            <SkeletonBlock className="eventTextSkeleton" />
            <SkeletonBlock className="eventTimeSkeleton" />
          </div>
        )) : displayEvents.length ? eventSections.map((section) => (
          <section className="eventTimeGroup" aria-labelledby={`event-time-group-${section.id}`} key={section.id}>
            <h3 className="eventTimeGroupHeading" id={`event-time-group-${section.id}`}>{section.label}</h3>
            <div className="eventTimeGroupList">
              {section.events.map((group) => {
                const timestamp = eventDate(group.timestamp, now);
                const presentation = recentEventPresentation(group);
                const relatedLabel = relatedEventLabel(group);
                return (
                  <article className={`eventRow ${group.severity} eventKind--${group.kind}`} key={group.id}>
                    <span className="eventIcon" aria-hidden="true">
                      <EventIcon kind={group.kind} />
                      {group.events.length > 1 && group.kind !== "player_reconnected" && group.kind !== "server_restarted" && (
                        <span className="eventOccurrenceBadge">×{group.events.length}</span>
                      )}
                    </span>
                    <div className="eventCopy">
                      <strong>{presentation.title}</strong>
                      {presentation.subject && <span className="eventSubject">{presentation.subject}</span>}
                      {group.events.length > 1 && group.kind !== "player_reconnected" && group.kind !== "server_restarted" && (
                        <span className="srOnly">{group.events.length} occurrences</span>
                      )}
                      {(presentation.details || relatedLabel) && (
                        <span className="eventDetailLine">
                          {presentation.details && <span>{presentation.details}</span>}
                          {relatedLabel && <span className="eventCount">{relatedLabel}</span>}
                        </span>
                      )}
                    </div>
                    <div className="eventMeta">
                      <small title={relativeTimestamps && timestamp ? formatDate(timestamp) : undefined}>
                        {relativeTimestamps ? formatRelativeEventTime(group.timestamp, now) : timestamp ? formatDate(timestamp) : group.timestamp ? "Unknown" : "No timestamp"}
                      </small>
                    </div>
                    <Button variant="ghost" iconOnly className="eventHideButton" onClick={() => void confirmHideEvent(group)} aria-label={`Hide events matching ${group.title}`}>
                      <svg viewBox="0 0 24 24" className="buttonIcon" aria-hidden="true">
                        <path d="M9.88 9.88a3 3 0 1 0 4.24 4.24" />
                        <path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68" />
                        <path d="M6.61 6.61A13.52 13.52 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61" />
                        <line x1="2" y1="2" x2="22" y2="22" />
                      </svg>
                    </Button>
                  </article>
                );
              })}
            </div>
          </section>
        )) : (
          <EmptyState
            compact
            className="eventEmpty"
            title={hasHiddenEvents ? "Recent events are hidden" : eventsStatus === "unavailable" ? "Events are unavailable" : "No recent events yet"}
            message={hasHiddenEvents ? "Reset hidden events to show them again." : eventsStatus === "unavailable" ? "Open the console to inspect raw logs, or try again after the server writes new output." : undefined}
          />
        )}
      </div>
      <Button variant="ghost" compact className="textLinkButton eventLogButton" onClick={onOpenConsole}>View full log</Button>
    </section>
  );
}
