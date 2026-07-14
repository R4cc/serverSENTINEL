import { useEffect, useMemo, useState } from 'react';
import type {
  ManagedServer,
  ModUpdatePlan,
  ResourceSample,
  RestartRequiredChange,
  ScheduledActiveRun,
  ScheduledExecution,
  ScheduledRun,
  ServerActivity,
  ServerEvent,
  ServerStatus
} from '../types';
import { formatUptime } from '../utils/resourceFormatting';
import { fabricLoaderVersionInfo, minecraftVersionInfo, versionValue } from '../utils/format';
import { Button, EmptyState, LoadingLabel, PanelHeader, SkeletonBlock, StatusBadge } from '../components/UiPrimitives';
import type { RequestConfirmation } from '../components/ConfirmationModal';

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

export type ModHealthSummary = {
  label: string;
  tone: "neutral" | "healthy" | "warning";
  totalInstalled: number;
  availableUpdates: number;
  attention: number;
};

export function buildModHealthSummary(updatePlan: ModUpdatePlan | null, options: { loading?: boolean; error?: string; canView?: boolean } = {}): ModHealthSummary {
  if (options.canView === false) return { label: "No access", tone: "neutral", totalInstalled: 0, availableUpdates: 0, attention: 0 };
  if (!updatePlan) {
    return {
      label: options.loading ? "Checking" : options.error ? "Unavailable" : "Not checked",
      tone: "neutral",
      totalInstalled: 0,
      availableUpdates: 0,
      attention: 0
    };
  }
  const { totalInstalled, safeUpdates, reviewUpdates, blockedUpdates, unknown } = updatePlan.counts;
  const availableUpdates = safeUpdates + reviewUpdates;
  const attention = blockedUpdates + unknown;
  if (totalInstalled === 0) return { label: "No mods", tone: "neutral", totalInstalled, availableUpdates, attention };
  if (availableUpdates > 0) return { label: `${availableUpdates} available`, tone: "warning", totalInstalled, availableUpdates, attention };
  if (attention > 0) return { label: `${attention} need attention`, tone: "warning", totalInstalled, availableUpdates, attention };
  return { label: "All up to date", tone: "healthy", totalInstalled, availableUpdates, attention };
}

export function OverviewSummary({
  server,
  status,
  dockerSocketMounted,
  activity,
  updatePlan = null,
  updatePlanLoading = false,
  updatePlanError = "",
  canViewMods = true,
  latestResourceSample,
  formatNumber = (value) => String(value),
  loading = false
}: {
  server: ManagedServer;
  status: ServerStatus | null;
  dockerSocketMounted: boolean;
  activity: ServerActivity;
  updatePlan?: ModUpdatePlan | null;
  updatePlanLoading?: boolean;
  updatePlanError?: string;
  canViewMods?: boolean;
  latestResourceSample?: ResourceSample;
  formatNumber?: (value: number) => string;
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
  const modHealth = buildModHealthSummary(updatePlan, { loading: updatePlanLoading, error: updatePlanError, canView: canViewMods });
  const hasResourceStats = Boolean(latestResourceSample?.available && latestResourceSample.running);
  const resourceFallback = running ? "Collecting" : "Not running";
  const cpu = hasResourceStats ? `${(latestResourceSample?.cpuPercent ?? 0).toFixed(1)}%` : resourceFallback;
  const memory = hasResourceStats
    ? `${formatNumber(Math.round((latestResourceSample?.memoryUsageBytes ?? 0) / 1024 / 1024))} MB`
    : resourceFallback;

  return (
    <section className="overviewSummary" aria-busy={loading || updatePlanLoading}>
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
      <div className={`summaryTile modSummaryTile ${modHealth.tone}`}>
        <span>Mod updates</span>
        <strong>{(loading || updatePlanLoading) && !updatePlan ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : modHealth.label}</strong>
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

function uniquePlayerNames(names?: string[]) {
  return Array.from(new Set((names ?? []).map((name) => name.trim()).filter(Boolean)));
}

export function ActivePlayersPanel({
  activity,
  running,
  loading = false
}: {
  activity: ServerActivity;
  running: boolean;
  loading?: boolean;
}) {
  const names = uniquePlayerNames(activity.playerNames);
  const online = activity.playersOnline;
  const unnamedPlayers = online === null || online === undefined ? 0 : Math.max(0, online - names.length);
  const countLabel = online === null || online === undefined
    ? "Unavailable"
    : activity.maxPlayers
      ? `${online} / ${activity.maxPlayers}`
      : String(online);

  let content;
  if (loading && online === undefined) {
    content = <div className="overviewPanelSkeleton" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <SkeletonBlock key={index} className="playerNameSkeleton" />)}</div>;
  } else if (!running) {
    content = <EmptyState compact title="Server is not running" message="Player activity will appear after the server starts." />;
  } else if (online === null || online === undefined) {
    content = <EmptyState compact title="Player query unavailable" message="Enable Minecraft Query or check the query endpoint to see the live roster." />;
  } else if (online === 0) {
    content = <EmptyState compact title="No players online" message="The server is ready for players." />;
  } else if (!names.length) {
    content = <EmptyState compact title={`${online} player${online === 1 ? "" : "s"} online`} message="The server reported a count but did not provide player names." />;
  } else {
    content = (
      <div className="activePlayerRoster">
        <div className="activePlayerGrid">
          {names.map((name) => (
            <div className="activePlayer" key={name}>
              <span className="activePlayerDot" aria-hidden="true" />
              <strong>{name}</strong>
            </div>
          ))}
        </div>
        {unnamedPlayers > 0 && <small>{unnamedPlayers} additional player{unnamedPlayers === 1 ? "" : "s"} did not include a name.</small>}
      </div>
    );
  }

  return (
    <section className="panel playersPanel overviewOperationsPanel" aria-busy={loading}>
      <PanelHeader title="Active Players" actions={<StatusBadge tone={running && online ? "success" : "neutral"}>{countLabel}</StatusBadge>} />
      {loading && <LoadingLabel>Loading active players</LoadingLabel>}
      {content}
    </section>
  );
}

const restartActionLabels: Record<RestartRequiredChange["action"], string> = {
  added: "Added",
  removed: "Removed",
  enabled: "Enabled",
  disabled: "Disabled",
  updated: "Updated"
};

export function ModHealthPanel({
  updatePlan,
  loading = false,
  error = "",
  canView = true,
  restartRequiredChanges = [],
  onOpenMods
}: {
  updatePlan: ModUpdatePlan | null;
  loading?: boolean;
  error?: string;
  canView?: boolean;
  restartRequiredChanges?: RestartRequiredChange[];
  onOpenMods: () => void;
}) {
  const summary = buildModHealthSummary(updatePlan, { loading, error, canView });
  const tone = summary.tone === "healthy" ? "success" : summary.tone === "warning" ? "warning" : "neutral";
  const restartSummary = canView && restartRequiredChanges.length > 0 && (
    <div className="pendingRestartSummary">
      <div><StatusBadge tone="warning">Restart required</StatusBadge><small>{restartRequiredChanges.length} pending change{restartRequiredChanges.length === 1 ? "" : "s"}</small></div>
      <ul>
        {restartRequiredChanges.map((change) => <li key={`${change.identity}:${change.action}`}><b>{restartActionLabels[change.action]}:</b> {change.displayName}</li>)}
      </ul>
    </div>
  );
  return (
    <section className="panel modsHealthPanel overviewOperationsPanel" aria-busy={loading}>
      <PanelHeader
        title="Mod Health"
        actions={canView && <Button variant="ghost" compact className="textLinkButton" onClick={onOpenMods}>Open Mods</Button>}
      />
      {loading && !updatePlan && <LoadingLabel>Checking mod health</LoadingLabel>}
      <div className="modHealthContent">
        {!canView ? (
          <EmptyState compact title="Mod status unavailable" message="View mods permission is required." />
        ) : !updatePlan ? (
          <EmptyState compact title={loading ? "Checking installed mods" : "Mod status unavailable"} message={error || "Open Mods to retry the update check."} />
        ) : (
          <>
          <div className="overviewMetricLead">
            <StatusBadge tone={tone}>{summary.label}</StatusBadge>
            <small>{summary.totalInstalled} installed</small>
          </div>
          <div className="overviewStatGrid">
            <div><span>Safe</span><strong>{updatePlan.counts.safeUpdates}</strong></div>
            <div><span>Review</span><strong>{updatePlan.counts.reviewUpdates}</strong></div>
            <div><span>Attention</span><strong>{summary.attention}</strong></div>
          </div>
          {error && <div className="overviewPanelNotice warning">The last refresh failed; the previous update plan is shown.</div>}
          </>
        )}
        {restartSummary}
      </div>
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
  onOpenSchedules
}: {
  schedules: ScheduledExecution[];
  canView?: boolean;
  formatDate: (value: string | number | Date) => string;
  onOpenSchedules: () => void;
}) {
  const snapshot = buildAutomationSnapshot(schedules);
  const recentStatus = scheduleStatus(snapshot.recent?.status);
  return (
    <section className="panel automationPanel overviewOperationsPanel">
      <PanelHeader
        title="Automation"
        actions={canView && <Button variant="ghost" compact className="textLinkButton" onClick={onOpenSchedules}>Open Schedules</Button>}
      />
      {!canView ? (
        <EmptyState compact title="Automation unavailable" message="View schedules permission is required." />
      ) : schedules.length === 0 ? (
        <EmptyState compact title="No schedules configured" message="Create recurring console actions from Schedules." />
      ) : (
        <div className="automationSummaryList">
          {snapshot.active && (
            <div className="automationSummaryRow active">
              <span>Running now</span>
              <strong>{snapshot.active.scheduleName}</strong>
              <small>{activeRunDetail(snapshot.active)}</small>
            </div>
          )}
          {snapshot.next && (
            <div className="automationSummaryRow">
              <span>Next run</span>
              <strong>{snapshot.next.name}</strong>
              <small title={snapshot.next.nextRunAt ? formatDate(snapshot.next.nextRunAt) : undefined}>{snapshot.next.nextRunAt ? formatRelativeScheduleTime(snapshot.next.nextRunAt) : "Not scheduled"}</small>
            </div>
          )}
          {snapshot.recent && (
            <div className="automationSummaryRow">
              <span>Latest run</span>
              <strong>{snapshot.recent.scheduleName}</strong>
              <small><StatusBadge tone={recentStatus.tone}>{recentStatus.label}</StatusBadge> {formatRelativeScheduleTime(snapshot.recent.ranAt)}</small>
            </div>
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
  const visibleEvents = useMemo(() => events.filter((event) => !hiddenSignatureSet.has(event.signature)), [events, hiddenSignatureSet]);
  const displayEvents = visibleEvents.slice(0, 8);
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
    if (confirmed) setHiddenSignatures((current) => current.includes(event.signature) ? current : [...current, event.signature]);
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
        )) : displayEvents.length ? displayEvents.map((event) => (
          <div className={`eventRow ${event.type}`} key={event.id}>
            <span className="eventMarker" aria-hidden="true" />
            <strong>{event.text}</strong>
            <small title={eventDate(event.timestamp, now) ? formatDate(eventDate(event.timestamp, now)!) : undefined}>{formatRelativeEventTime(event.timestamp, now)}</small>
            <Button variant="ghost" iconOnly className="eventHideButton" onClick={() => void confirmHideEvent(event)} aria-label="Hide events of this type">
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
            message={hasHiddenEvents ? "Reset hidden events to show them again." : eventsStatus === "unavailable" ? "Open the console to inspect raw logs, or try again after the server writes new output." : undefined}
          />
        )}
      </div>
      <Button variant="ghost" compact className="textLinkButton eventLogButton" onClick={onOpenConsole}>View full log</Button>
    </section>
  );
}
