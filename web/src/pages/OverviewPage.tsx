import { useEffect, useMemo, useState } from 'react';
import type {
  ManagedServer,
  ModUpdatePlan,
  PlayerSnapshot,
  ScheduledActiveRun,
  ScheduledExecution,
  ScheduleNavigationTarget,
  ScheduledRun,
  ServerActivity,
  ServerEvent,
  ServerStatus
} from '../types';
import { formatUptime } from '../utils/resourceFormatting';
import { fabricLoaderVersionInfo, minecraftVersionInfo, versionValue } from '../utils/format';
import { Button, EmptyState, LoadingLabel, PanelHeader, SkeletonBlock, StatusBadge } from '../components/UiPrimitives';
import type { RequestConfirmation } from '../components/ConfirmationModal';
import { AppIcon } from '../components/FileTypeIcon';
import { ModIconImage } from '../features/mods/ModIconImage';
import { modIconSource } from '../utils/appHelpers';
import { playerEventSubject, playerReconnectWindowMs, samePlayerName } from '../utils/serverEvents';

const hiddenRecentEventsKey = 'serversentinel-hidden-recent-event-signatures';

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
  const fabricLoaderVersion = fabricLoaderVersionInfo(server);
  const hasResourceStats = Boolean(latestResourceSample?.available && latestResourceSample.running);
  const resourceFallback = running ? "Collecting" : "Not running";
  const cpu = hasResourceStats ? `${(latestResourceSample?.cpuPercent ?? 0).toFixed(1)}%` : resourceFallback;
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

function snapshotAge(sampledAt: string) {
  const seconds = Math.max(0, Math.round((Date.now() - new Date(sampledAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
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
        {snapshot.state === "stale" && <small>Last verified {snapshotAge(snapshot.sampledAt)}. {snapshot.message}</small>}
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
  onOpenMods
}: {
  updatePlan: ModUpdatePlan | null;
  loading?: boolean;
  canView?: boolean;
  onOpenMods: () => void;
}) {
  if (!canView) return null;
  if (loading || !updatePlan) return <ModHealthPanelSkeleton />;

  const updateCount = updatePlan.counts.safeUpdates + updatePlan.counts.reviewUpdates;
  const availableUpdates = updatePlan.updates.filter((entry) => entry.status === "safe_update" || entry.status === "needs_review");
  const visibleUpdates = availableUpdates.slice(0, 3);
  const remainingUpdates = Math.max(0, availableUpdates.length - visibleUpdates.length);
  if (updateCount === 0) {
    return (
      <button
        type="button"
        className="panel modsHealthPanel modUpdatesCard modUpdatesCard--healthy"
        onClick={onOpenMods}
        aria-label="Open Mods, no mod updates available"
      >
        <span className="modUpdatesCompact">
          <span>No mod updates available</span>
          <strong><AppIcon name="check" /></strong>
        </span>
        <span className="modUpdatesWide" aria-hidden="true">
          <span className="modUpdatesWideHeader">
            <span>
              <strong>Mod updates</strong>
              <small>No updates available</small>
            </span>
            <AppIcon name="chevronRight" />
          </span>
          <span className="modUpdatesHealthyState">
            <span className="modUpdatesHealthyIcon"><AppIcon name="check" /></span>
            <span>
              <strong>Everything is up to date</strong>
              <small>New mod updates will appear here.</small>
            </span>
          </span>
        </span>
      </button>
    );
  }

  return (
    <button
      type="button"
      className="panel modsHealthPanel modUpdatesCard"
      onClick={onOpenMods}
      aria-label={`Open Mods, ${updateCount} mod update${updateCount === 1 ? "" : "s"} available`}
    >
      <span className="modUpdatesCompact">
        <span>Mod updates available</span>
        <strong>{updateCount}</strong>
      </span>
      <span className="modUpdatesWide" aria-hidden="true">
        <span className="modUpdatesWideHeader">
          <span>
            <strong>Mod updates available</strong>
            <small>{updateCount} update{updateCount === 1 ? "" : "s"} ready to view</small>
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
  );
}

function ModHealthPanelSkeleton() {
  return (
    <section className="panel modsHealthPanel modUpdatesCard modUpdatesCardSkeleton" aria-busy="true">
      <LoadingLabel>Loading mod updates</LoadingLabel>
      <span className="modUpdatesCompact" aria-hidden="true">
        <SkeletonBlock className="modUpdatesTitleSkeleton" />
        <SkeletonBlock className="modUpdatesCountSkeleton" />
      </span>
      <span className="modUpdatesWide modUpdatesWideSkeleton" aria-hidden="true">
        <span className="modUpdatesWideHeader">
          <span>
            <SkeletonBlock className="modUpdatesWideTitleSkeleton" />
            <SkeletonBlock className="modUpdatesWideMetaSkeleton" />
          </span>
          <SkeletonBlock className="modUpdatesChevronSkeleton" />
        </span>
        <span className="modUpdatesList">
          {Array.from({ length: 3 }, (_, index) => (
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

export type AutomationSnapshot = {
  active?: ScheduledActiveRun;
  next?: ScheduledExecution;
  recent?: ScheduledRun;
};

export function buildAutomationSnapshot(schedules: ScheduledExecution[], now = new Date()): AutomationSnapshot {
  const active = schedules.flatMap((schedule) => schedule.activeRuns ?? [])
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())[0];
  const next = schedules
    .filter((schedule) => schedule.enabled && schedule.nextRunAt && new Date(schedule.nextRunAt).getTime() >= now.getTime())
    .sort((a, b) => new Date(a.nextRunAt!).getTime() - new Date(b.nextRunAt!).getTime())[0];
  const recent = schedules.flatMap((schedule) => schedule.recentRuns?.length
    ? schedule.recentRuns
    : schedule.lastRunAt ? [{
      id: `${schedule.id}:${schedule.lastRunAt}`,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      status: schedule.lastStatus ?? "unknown",
      message: schedule.lastMessage,
      ranAt: schedule.lastRunAt
    }] : [])
    .sort((a, b) => new Date(b.ranAt).getTime() - new Date(a.ranAt).getTime())[0];
  return { active, next, recent };
}

export function formatRelativeScheduleTime(value: string, now = new Date()) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown";
  const diffMs = date.getTime() - now.getTime();
  const minutes = Math.max(1, Math.round(Math.abs(diffMs) / 60_000));
  const label = minutes >= 1_440 ? `${Math.round(minutes / 1_440)}d` : minutes >= 60 ? `${Math.round(minutes / 60)}h` : `${minutes}m`;
  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

function scheduleStatus(status?: string) {
  const normalized = (status ?? "").toLowerCase();
  if (normalized === "success" || normalized === "succeeded") return { label: "Succeeded", tone: "success" as const };
  if (normalized === "failed") return { label: "Failed", tone: "danger" as const };
  if (normalized === "skipped" || normalized === "cancelled") return { label: normalized === "skipped" ? "Skipped" : "Cancelled", tone: "warning" as const };
  return { label: "Unknown", tone: "neutral" as const };
}

function activeRunDetail(run: ScheduledActiveRun) {
  if (run.waitingUntil) return `Waiting ${formatRelativeScheduleTime(run.waitingUntil)}`;
  if (run.currentStep) return run.currentStep;
  if (run.currentStepIndex !== undefined) return `Step ${run.currentStepIndex + 1} of ${run.stepCount}`;
  return run.message || "In progress";
}

export function AutomationPanel({
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
  const snapshot = buildAutomationSnapshot(schedules);
  const recentStatus = scheduleStatus(snapshot.recent?.status);
  const recentTime = snapshot.recent
    ? relativeTimestamps ? formatRelativeScheduleTime(snapshot.recent.ranAt) : formatDate(snapshot.recent.ranAt)
    : "";
  const nextTime = snapshot.next?.nextRunAt
    ? relativeTimestamps ? formatRelativeScheduleTime(snapshot.next.nextRunAt) : formatDate(snapshot.next.nextRunAt)
    : "Not scheduled";
  return (
    <section className="panel automationPanel overviewOperationsPanel">
      <PanelHeader
        title="Automation"
        actions={canView && <Button variant="ghost" compact className="textLinkButton" onClick={() => onOpenSchedules()}>Open Schedules</Button>}
      />
      {!canView ? (
        <EmptyState compact title="Automation unavailable" message="View schedules permission is required." />
      ) : schedules.length === 0 ? (
        <EmptyState compact title="No schedules configured" message="Create recurring console actions from Schedules." />
      ) : (
        <div className={`automationTimeline${snapshot.active ? " hasActiveRun" : ""}`}>
          {snapshot.recent && (
            <button
              type="button"
              className={`automationTimelineItem automationTimelineItem--past tone-${recentStatus.tone}`}
              onClick={() => onOpenSchedules({ kind: "completed-run", scheduleId: snapshot.recent!.scheduleId, runId: snapshot.recent!.id })}
              aria-label={`View details for ${snapshot.recent.scheduleName}, ${recentStatus.label}, ${recentTime}`}
            >
              <span className="automationTimelineNode" aria-hidden="true" />
              <span className="automationTimelineCopy">
                <span className="automationTimelineLabel">Last run</span>
                <strong>{snapshot.recent.scheduleName}</strong>
                <time className="automationTimelineMeta" dateTime={snapshot.recent.ranAt} title={relativeTimestamps ? formatDate(snapshot.recent.ranAt) : undefined}>{recentTime}</time>
              </span>
              <span className={`automationTimelineStatus tone-${recentStatus.tone}`} aria-hidden="true">
                {recentStatus.tone === "success" ? <AppIcon name="check" /> : recentStatus.tone === "danger" ? <AppIcon name="x" /> : recentStatus.tone === "warning" ? "!" : "?"}
              </span>
              <AppIcon name="chevronRight" />
            </button>
          )}
          {snapshot.active ? (
            <button
              type="button"
              className="automationTimelineItem automationTimelineItem--active"
              onClick={() => onOpenSchedules({ kind: "active-run", scheduleId: snapshot.active!.scheduleId, runId: snapshot.active!.id })}
              aria-label={`Open active run ${snapshot.active.scheduleName}, ${activeRunDetail(snapshot.active)}`}
            >
              <span className="automationTimelineNode" aria-hidden="true" />
              <span className="automationTimelineCopy">
                <span className="automationTimelineLabel">Running now</span>
                <strong>{snapshot.active.scheduleName}</strong>
                <span className="automationTimelineMeta">{activeRunDetail(snapshot.active)}</span>
              </span>
              <AppIcon name="chevronRight" />
            </button>
          ) : (
            <div className="automationTimelineNow" aria-label="Now">
              <span className="automationTimelineNode" aria-hidden="true" />
              <span>Now</span>
            </div>
          )}
          {snapshot.next && (
            <button
              type="button"
              className="automationTimelineItem automationTimelineItem--future"
              onClick={() => onOpenSchedules({ kind: "schedule", scheduleId: snapshot.next!.id })}
              aria-label={`Open ${snapshot.next.name}, next run ${nextTime}`}
            >
              <span className="automationTimelineNode" aria-hidden="true" />
              <span className="automationTimelineCopy">
                <span className="automationTimelineLabel">Next up</span>
                <strong>{snapshot.next.name}</strong>
                <time className="automationTimelineMeta" dateTime={snapshot.next.nextRunAt} title={relativeTimestamps && snapshot.next.nextRunAt ? formatDate(snapshot.next.nextRunAt) : undefined}>{nextTime}</time>
              </span>
              <AppIcon name="chevronRight" />
            </button>
          )}
          {!snapshot.active && !snapshot.next && !snapshot.recent && <EmptyState compact title="No automation activity yet" message="Enabled schedules will appear here when they run." />}
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

type RecentEventKind = ServerEvent["eventType"] | "player_reconnected" | "server_restarted";

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

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const next = events[index + 1];
    const duration = next ? secondsBetween(event, next, now) : null;

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

    const repeatable = ["exception_caught", "server_overloaded", "server_crashed", "mod_disabled"].includes(event.eventType);
    const repeated = [event];
    if (repeatable) {
      while (events[index + 1]?.signature === event.signature) {
        const repeatedDuration = secondsBetween(event, events[index + 1], now);
        if (repeatedDuration === null || repeatedDuration > 60) break;
        repeated.push(events[index + 1]);
        index += 1;
      }
    }

    groups.push({
      id: repeated.map((item) => item.id).join(":"),
      kind: event.eventType,
      severity: event.severity,
      title: event.text,
      details: repeated.length > 1
        ? `${defaultEventDetails(event) ?? "The same event was logged"} · ${repeated.length} occurrences within a minute`
        : defaultEventDetails(event),
      timestamp: event.timestamp,
      events: repeated
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
    : `${group.events.length} occurrences`;
}

function EventIcon({ kind }: { kind: RecentEventKind }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {kind === "player_joined" && <><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.5-3.5 2.3-5 5.5-5 2 0 3.5.6 4.4 2" /><path d="M15 10h6m-3-3 3 3-3 3" /></>}
      {kind === "player_left" && <><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.5-3.5 2.3-5 5.5-5 2 0 3.5.6 4.4 2" /><path d="M21 10h-6m3-3-3 3 3 3" /></>}
      {kind === "player_reconnected" && <><circle cx="8" cy="8" r="3" /><path d="M2.5 19c.5-3.5 2.3-5 5.5-5 1.4 0 2.5.3 3.4.8" /><path d="M14 10a5 5 0 1 1-1 7m1 3-1-3 3-1" /></>}
      {kind === "server_started" && <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 8 6 4-6 4Z" /></>}
      {kind === "server_stopped" && <><rect x="3" y="4" width="18" height="16" rx="3" /><rect x="9" y="9" width="6" height="6" /></>}
      {kind === "server_restarted" && <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M8 12a4 4 0 0 1 7-2m1-2-1 2-2-1" /><path d="M16 12a4 4 0 0 1-7 2m-1 2 1-2 2 1" /></>}
      {kind === "mod_disabled" && <><path d="M8 3h8v4a2 2 0 1 1 0 4v10H8v-4a2 2 0 1 0 0-4Z" /><path d="m4 4 16 16" /></>}
      {kind === "server_crashed" && <><path d="M12 3 2.5 20h19Z" /><path d="M12 9v5m0 3h.01" /></>}
      {kind === "exception_caught" && <><path d="M8 8h8v9a4 4 0 0 1-8 0Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2M4 12h4m8 0h4M5 18l3-2m11 2-3-2" /></>}
      {kind === "server_overloaded" && <><path d="M4 18a8 8 0 1 1 16 0" /><path d="m12 14 4-4" /><path d="M7 18h10" /></>}
    </svg>
  );
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
                    <span className="eventIcon" aria-hidden="true"><EventIcon kind={group.kind} /></span>
                    <div className="eventCopy">
                      <strong>{presentation.title}</strong>
                      {presentation.subject && <span className="eventSubject">{presentation.subject}</span>}
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
