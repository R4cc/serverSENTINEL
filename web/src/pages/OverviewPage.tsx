import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState
} from '@tanstack/react-table';
import { Activity, Blocks, Clock, Cpu, Globe, HardDrive, MemoryStick, TriangleAlert } from 'lucide-react';
import type {
  ManagedServer,
  ModUpdatePlan,
  PlayerSnapshot,
  ScheduledActiveRun,
  ScheduledExecution,
  ScheduleNavigationTarget,
  ServerActivity,
  ServerEvent,
  ServerStatus
} from '../types';
import { formatUptime } from '../utils/resourceFormatting';
import { formatAdaptiveBytes, formatRelativeTimestamp, minecraftVersionInfo, versionValue } from '../utils/format';
import { Button, EmptyState, HelpTooltip, LoadingLabel, MetricTile, PanelHeader, SkeletonBlock, StatusBadge, Surface } from '../components/UiPrimitives';
import { AppIcon, SidebarIcon } from '../components/FileTypeIcon';
import { EventIcon, type EventIconKind } from '../components/EventIcon';
import { ModIconImage } from '../features/mods/ModIconImage';
import { modIconSource } from '../utils/appHelpers';
import { groupNearbyRepeatedEvents, playerEventSubject, playerReconnectWindowMs, samePlayerName } from '../utils/serverEvents';
import { playerHeadVersion } from '../utils/playerHeads';
import { usePlayerHead } from '../components/PlayerHead';
import { schedulesNeedingAttention } from '../features/schedules/scheduleHealth';
import { SortHeaderButton, TablePagination, headerAriaSort } from '../components/TableControls';
import { InlineState } from '../components/InlineState';

const activePlayerPreviewLimit = 8;
const overviewSupportCardSlotCount = 4;
const upcomingScheduleDisplayLimit = 4;
const upcomingScheduleWindowMs = 24 * 60 * 60 * 1000;
const serverEventsPageSize = 10;

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

function summaryMetricTone(status: ServerStatus | null, dockerSocketMounted: boolean) {
  const tone = summaryTone(status, dockerSocketMounted);
  if (tone === "running") return "success" as const;
  if (tone === "warning") return "warning" as const;
  if (tone === "danger" || tone === "stopped") return "danger" as const;
  return "neutral" as const;
}

export function storageRemainingIsLow(availableBytes: number | null, totalBytes: number | null) {
  return availableBytes !== null
    && totalBytes !== null
    && Number.isFinite(availableBytes)
    && Number.isFinite(totalBytes)
    && availableBytes >= 0
    && totalBytes > 0
    && availableBytes / totalBytes <= 0.1;
}

function OverviewCard({
  title,
  description,
  actions,
  className,
  children,
  loading = false
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
  loading?: boolean;
}) {
  return (
    <Surface className={`overviewCard${className ? ` ${className}` : ""}`} aria-busy={loading || undefined}>
      <PanelHeader compact title={title} description={description} actions={actions} />
      {children}
    </Surface>
  );
}

function OverviewCardState({
  title,
  message,
  icon,
  tone = "neutral",
  onClick,
  ariaLabel
}: {
  title: ReactNode;
  message?: ReactNode;
  icon: ReactNode;
  tone?: "neutral" | "success" | "warning";
  onClick?: () => void;
  ariaLabel?: string;
}) {
  const content = (
    <>
      <span className={`overviewCardStateIcon tone-${tone}`}>{icon}</span>
      <span className="overviewCardStateCopy">
        <strong>{title}</strong>
        {message && <small>{message}</small>}
      </span>
      {onClick && <AppIcon name="chevronRight" />}
    </>
  );

  return onClick ? (
    <button type="button" className="overviewCardRow overviewCardStateItem" onClick={onClick} aria-label={ariaLabel}>
      {content}
    </button>
  ) : <div className="overviewCardRow overviewCardStateItem">{content}</div>;
}

export function OverviewSummary({
  server,
  status,
  dockerSocketMounted,
  activity,
  latestResourceSample,
  worldSizeBytes = null,
  storageAvailableBytes = null,
  storageTotalBytes = null,
  storageLoading = false,
  loading = false
}: {
  server: ManagedServer;
  status: ServerStatus | null;
  dockerSocketMounted: boolean;
  activity: ServerActivity;
  latestResourceSample?: {
    available: boolean;
    running: boolean;
    cpuPercent: number | null;
    cpuUtilizationPercent?: number | null;
    cpuCapacityCores?: number;
    memoryUsageBytes: number | null;
    memoryUtilizationPercent?: number | null;
  };
  worldSizeBytes?: number | null;
  storageAvailableBytes?: number | null;
  storageTotalBytes?: number | null;
  storageLoading?: boolean;
  loading?: boolean;
}) {
  const running = Boolean(status?.docker.running);
  const state = dockerStateLabel(status, dockerSocketMounted);
  const minecraftVersion = minecraftVersionInfo(server);
  const hasResourceStats = Boolean(latestResourceSample?.available && latestResourceSample.running);
  const resourceFallback = running ? "Collecting" : "Not running";
  const normalizedCpu = latestResourceSample?.cpuUtilizationPercent
    ?? (latestResourceSample?.cpuCapacityCores && latestResourceSample.cpuPercent !== null
      ? latestResourceSample.cpuPercent / latestResourceSample.cpuCapacityCores
      : null);
  const cpu = hasResourceStats && normalizedCpu !== null ? `${normalizedCpu.toFixed(1)}%` : resourceFallback;
  const memory = hasResourceStats && latestResourceSample?.memoryUtilizationPercent != null
    ? `${latestResourceSample.memoryUtilizationPercent.toFixed(1)}%`
    : resourceFallback;
  const storageLow = storageRemainingIsLow(storageAvailableBytes, storageTotalBytes);
  const storagePercent = storageAvailableBytes !== null && storageTotalBytes !== null && storageTotalBytes > 0
    ? Math.max(0, Math.min(100, storageAvailableBytes / storageTotalBytes * 100))
    : null;
  const storageValue = storageAvailableBytes === null ? "Unavailable" : formatAdaptiveBytes(storageAvailableBytes);
  const storageTitle = storageAvailableBytes !== null && storageTotalBytes !== null
    ? `${storageValue} available of ${formatAdaptiveBytes(storageTotalBytes)}${storagePercent === null ? "" : ` (${storagePercent.toFixed(1)}% remaining)`}`
    : undefined;

  return (
    <section className="overviewSummary" aria-busy={loading}>
      {loading && <LoadingLabel>Loading server summary</LoadingLabel>}
      <MetricTile
        className={`summaryTile state statusTile ${summaryTone(status, dockerSocketMounted)}`}
        label="Status"
        icon={<Activity />}
        iconPlacement="leading"
        tone={summaryMetricTone(status, dockerSocketMounted)}
        value={<span className="summaryStatusText">{state}</span>}
      />
      <MetricTile className="summaryTile" label="Minecraft" icon={<Blocks />} iconPlacement="leading" value={versionValue(minecraftVersion)} />
      <MetricTile className="summaryTile" label="Uptime" icon={<Clock />} iconPlacement="leading" value={loading ? <SkeletonBlock className="overviewSummaryValueSkeleton" /> : running ? formatUptime(activity.lastStartedAt, running) : "Not running"} />
      <MetricTile
        className="summaryTile"
        label="World Size"
        icon={<Globe />}
        iconPlacement="leading"
        value={worldSizeBytes === null
          ? storageLoading
            ? <SkeletonBlock className="overviewSummaryValueSkeleton" />
            : "Unavailable"
          : <span className="summaryByteValue" title={`${worldSizeBytes.toLocaleString()} bytes`}>{formatAdaptiveBytes(worldSizeBytes)}</span>}
      />
      <MetricTile
        className="summaryTile storageRemainingTile"
        label="Free Space"
        icon={<HardDrive />}
        iconPlacement="leading"
        tone={storageLow ? "warning" : "neutral"}
        value={storageAvailableBytes === null
          ? storageLoading
            ? <SkeletonBlock className="overviewSummaryValueSkeleton" />
            : "Unavailable"
          : (
              <span
                className={`summaryByteValue summaryStorageValue${storageLow ? " summaryStorageValue--warning" : ""}`}
                title={storageTitle}
                aria-label={`${storageValue} remaining${storageLow ? ", storage almost full" : ""}`}
              >
                {storageLow && <TriangleAlert aria-hidden="true" />}
                <span>{storageValue}</span>
              </span>
            )}
      />
      <MetricTile className="summaryTile overviewWideSummaryTile" label="CPU" icon={<Cpu />} iconPlacement="leading" value={cpu} />
      <MetricTile className="summaryTile overviewWideSummaryTile" label="Memory" icon={<MemoryStick />} iconPlacement="leading" value={memory} />
    </section>
  );
}

export function ActivePlayersPanel({
  snapshot,
  running,
  loading = false,
  serverId = "",
  playerHeadsEnabled = false
}: {
  snapshot?: PlayerSnapshot;
  running: boolean;
  loading?: boolean;
  serverId?: string;
  playerHeadsEnabled?: boolean;
}) {
  const [playersExpanded, setPlayersExpanded] = useState(false);
  useEffect(() => setPlayersExpanded(false), [serverId]);
  const available = snapshot?.state === "live" || snapshot?.state === "stale" ? snapshot : undefined;
  const online = available?.online;
  const countLabel = available
    ? available.maxPlayers ? `${available.online} / ${available.maxPlayers}` : String(available.online)
    : snapshot?.state === "stopped"
      ? "Stopped"
      : snapshot?.state === "unavailable"
        ? "Retrying"
        : "Checking";
  const countTone = available?.state === "stale" || snapshot?.state === "unavailable"
    ? "warning"
    : running && online
      ? "success"
      : "neutral";

  let content;
  if (loading && !snapshot) {
    content = <div className="overviewPanelSkeleton" aria-hidden="true">{Array.from({ length: 4 }, (_, index) => <SkeletonBlock key={index} className="playerNameSkeleton" />)}</div>;
  } else if (!running || snapshot?.state === "stopped") {
    content = <OverviewCardState title="Server offline" message="Player activity will appear when it starts." icon={<SidebarIcon name="players" />} />;
  } else if (!snapshot || snapshot.state === "unavailable") {
    const lastChecked = snapshot?.lastAttemptAt
      ? `Last checked ${formatRelativeTimestamp(snapshot.lastAttemptAt).toLocaleLowerCase()}.`
      : undefined;
    const unavailableCopy = !snapshot
      ? { title: "Checking player status", message: "The current player list will appear after the first completed check." }
      : snapshot.code === "QUERY_DISABLED"
        ? { title: "Player list not enabled", message: "Enable Minecraft Query for this server to show who is online." }
        : snapshot.code === "NODE_UNAVAILABLE"
          ? { title: "Waiting for the node", message: "Player status will update automatically when the node reconnects." }
          : { title: "Player status delayed", message: `${lastChecked ? `${lastChecked} ` : ""}Retrying automatically.` };
    content = <OverviewCardState {...unavailableCopy} icon={<SidebarIcon name="players" />} tone="warning" />;
  } else if (online === 0) {
    content = <OverviewCardState title="No players online" message="The player list is up to date." icon={<SidebarIcon name="players" />} />;
  } else {
    const visibleNames = playersExpanded ? snapshot.names : snapshot.names.slice(0, activePlayerPreviewLimit);
    const hiddenPlayerCount = snapshot.names.length - visibleNames.length;
    const rosterCanExpand = snapshot.names.length > activePlayerPreviewLimit;
    const headVersion = playerHeadVersion();

    content = (
      <div className="activePlayerRoster">
        <div className="activePlayerGrid" id="active-player-grid">
          {visibleNames.map((name) => (
            <ActivePlayerRow
              key={name}
              serverId={serverId}
              playerName={name}
              playerHeadsEnabled={playerHeadsEnabled}
              version={headVersion}
            />
          ))}
        </div>
        {(rosterCanExpand || snapshot.state === "stale") && (
          <div className="activePlayerRosterFooter">
            {rosterCanExpand && (
              <Button
                variant="ghost"
                compact
                className="activePlayerRosterToggle"
                aria-controls="active-player-grid"
                aria-expanded={playersExpanded}
                onClick={() => setPlayersExpanded((expanded) => !expanded)}
              >
                {playersExpanded
                  ? "Show fewer players"
                  : `Show ${hiddenPlayerCount} more ${hiddenPlayerCount === 1 ? "player" : "players"}`}
                <AppIcon name={playersExpanded ? "chevronUp" : "chevronDown"} />
              </Button>
            )}
            {snapshot.state === "stale" && (
              <small className="activePlayerUpdatedAt">
                Updated {formatRelativeTimestamp(snapshot.sampledAt).toLocaleLowerCase()}
              </small>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <OverviewCard
      className="playersPanel overviewOperationsPanel"
      title="Active Players"
      actions={<StatusBadge tone={countTone}>{countLabel}</StatusBadge>}
      loading={loading}
    >
      {loading && <LoadingLabel>Loading active players</LoadingLabel>}
      <div className="overviewCardBody">{content}</div>
    </OverviewCard>
  );
}

/** Player head image state, falling back to the caller's own icon once a head fails to load. */
function ActivePlayerRow({
  serverId,
  playerName,
  playerHeadsEnabled,
  version
}: {
  serverId: string;
  playerName: string;
  playerHeadsEnabled: boolean;
  version: number;
}) {
  const { source, showHead, onHeadError } = usePlayerHead(serverId, playerName, version, playerHeadsEnabled);
  return (
    <div className={`activePlayer ${showHead ? "activePlayer--withHead" : ""}`.trim()}>
      {showHead ? (
        <span className="activePlayerHead" aria-hidden="true">
          <img src={source} alt="" loading="lazy" decoding="async" onError={onHeadError} />
          <span className="activePlayerHeadStatus" />
        </span>
      ) : <span className="activePlayerDot" aria-hidden="true" />}
      <strong title={playerName}>{playerName}</strong>
    </div>
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
  if (!updatePlan) return <ModHealthPanelSkeleton contentPlural={contentPlural} />;
  const contentSingular = contentPlural === "plugins" ? "plugin" : "mod";
  const contentSingularTitle = contentPlural === "plugins" ? "Plugin" : "Mod";

  const updateCount = updatePlan.counts.safeUpdates + updatePlan.counts.reviewUpdates;
  const availableUpdates = updatePlan.updates.filter((entry) => entry.status === "safe_update" || entry.status === "needs_review");
  const visibleUpdates = availableUpdates.slice(0, overviewSupportCardSlotCount);
  const remainingUpdates = Math.max(0, availableUpdates.length - visibleUpdates.length);
  const actions = (
    <div className="overviewCardHeaderActions">
      <ModUpdatesRefreshButton contentPlural={contentPlural} onRefresh={onRefresh} loading={loading} />
    </div>
  );

  return (
    <OverviewCard
      className={`modsHealthPanel modUpdatesCard${updateCount === 0 ? " modUpdatesCard--healthy" : ""}`}
      title={`${contentSingularTitle} updates`}
      actions={actions}
      loading={loading}
    >
      <div className="overviewCardList overviewSupportList modUpdatesList">
        {loading && <LoadingLabel>Refreshing {contentSingular} updates</LoadingLabel>}
        {updateCount === 0 ? (
          <OverviewCardState
            title="Everything is up to date"
            icon={<AppIcon name="check" />}
            tone="success"
            onClick={onOpenMods}
            ariaLabel={`Open ${contentPluralTitle}, no ${contentSingular} updates available`}
          />
        ) : visibleUpdates.map((entry) => (
          <button
            type="button"
            className="overviewCardRow overviewSupportListItem modUpdatesListItem"
            key={entry.filename}
            onClick={onOpenMods}
            title={`Open ${entry.displayName} update in ${contentPluralTitle}`}
          >
            <ModIconImage src={modIconSource(entry.iconUrl)} fallback="MOD" />
            <span className="overviewSupportListCopy modUpdatesListCopy">
              <strong title={entry.displayName}>{entry.displayName}</strong>
              <small>
                {entry.currentVersion && <span>{entry.currentVersion}</span>}
                {entry.currentVersion && entry.targetVersion && <span aria-hidden="true">→</span>}
                <span>{entry.targetVersion ?? "Update available"}</span>
              </small>
            </span>
            <AppIcon name="chevronRight" />
          </button>
        ))}
      </div>
      {remainingUpdates > 0 && (
        <Button variant="ghost" compact className="overviewSupportMore modUpdatesRemaining" onClick={onOpenMods}>
          {remainingUpdates} more update{remainingUpdates === 1 ? "" : "s"}
        </Button>
      )}
    </OverviewCard>
  );
}

function ModUpdatesRefreshButton({ contentPlural, onRefresh, loading = false }: { contentPlural: "mods" | "plugins"; onRefresh?: () => void; loading?: boolean }) {
  if (!onRefresh) return null;
  const label = `Recheck ${contentPlural} for updates`;
  return (
    <Button
      variant="secondary"
      compact
      iconOnly
      className={`modUpdatesRefreshButton${loading ? " isRefreshing" : ""}`}
      onClick={onRefresh}
      aria-label={label}
      aria-busy={loading}
      title={label}
      disabled={loading}
    >
      <AppIcon name="refresh" />
    </Button>
  );
}

function ModHealthPanelSkeleton({
  contentPlural = "mods"
}: {
  contentPlural?: "mods" | "plugins";
}) {
  const contentSingular = contentPlural === "plugins" ? "plugin" : "mod";
  const contentSingularTitle = contentPlural === "plugins" ? "Plugin" : "Mod";
  return (
    <OverviewCard
      className="modsHealthPanel modUpdatesCard modUpdatesCardSkeleton"
      title={`${contentSingularTitle} updates`}
      actions={<div className="overviewCardHeaderActions">
        <Button variant="secondary" compact iconOnly className="modUpdatesRefreshButton isRefreshing" disabled aria-busy="true" aria-label={`Recheck ${contentPlural} for updates`}><AppIcon name="refresh" /></Button>
      </div>}
      loading
    >
      <div className="overviewCardList overviewSupportList modUpdatesList" aria-hidden="true">
        <LoadingLabel>Loading {contentSingular} updates</LoadingLabel>
        {Array.from({ length: 1 }, (_, index) => (
          <div className="overviewCardRow overviewSupportListItem modUpdatesListItem" key={index}>
            <SkeletonBlock className="modUpdatesIconSkeleton" />
            <span className="overviewSupportListCopy modUpdatesListCopy">
              <SkeletonBlock className="modUpdatesNameSkeleton" />
              <SkeletonBlock className="modUpdatesVersionSkeleton" />
            </span>
            <SkeletonBlock className="modUpdatesChevronSkeleton" />
          </div>
        ))}
      </div>
    </OverviewCard>
  );
}

export function modUpdateRefreshResultMessage(updatePlan: ModUpdatePlan, contentPlural: "mods" | "plugins") {
  const updateCount = updatePlan.counts.safeUpdates + updatePlan.counts.reviewUpdates;
  if (updateCount === 0) return "Everything is up to date";
  const contentSingular = contentPlural === "plugins" ? "plugin" : "mod";
  return `${updateCount} ${contentSingular} update${updateCount === 1 ? "" : "s"} available`;
}

type UpcomingScheduleSnapshot = {
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

function formatActiveScheduleDuration(startedAt: string, now = Date.now()) {
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "just now";
  const minutes = Math.max(0, Math.floor((now - started) / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function activeScheduleStatus(run: ScheduledActiveRun) {
  return run.message?.trim() || run.currentStep?.trim() || "Running";
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
  const [now, setNow] = useState(() => Date.now());
  const activeRuns = useMemo(() => schedules.flatMap((schedule) => (
    (schedule.activeRuns ?? []).map((run) => ({ schedule, run }))
  )).sort((left, right) => (
    new Date(left.run.startedAt).getTime() - new Date(right.run.startedAt).getTime()
      || left.run.id.localeCompare(right.run.id)
  )), [schedules]);
  useEffect(() => {
    if (!activeRuns.length) return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [activeRuns.length]);

  const snapshot = buildUpcomingScheduleSnapshot(schedules, new Date(now));
  const visibleActiveRuns = activeRuns.slice(0, overviewSupportCardSlotCount);
  const visibleUpcomingSchedules = snapshot.schedules.slice(0, Math.max(0, overviewSupportCardSlotCount - visibleActiveRuns.length));
  const hiddenScheduleCount = Math.max(0, activeRuns.length - visibleActiveRuns.length)
    + snapshot.remainingInNext24Hours
    + Math.max(0, snapshot.schedules.length - visibleUpcomingSchedules.length);
  // A schedule failing or skipping its way through several occurrences says nothing anywhere else,
  // and the next run it advertises here is exactly as reassuring as a working one's.
  const attention = canView ? schedulesNeedingAttention(schedules) : [];
  return (
    <OverviewCard
      className="schedulePanel overviewOperationsPanel"
      title="Schedules"
    >
      {attention.length > 0 && (
        <div className="scheduleAttentionList">
          {attention.map(({ schedule, health }) => (
            <button
              key={schedule.id}
              type="button"
              className={`scheduleAttentionItem ${health.tone}`}
              onClick={() => onOpenSchedules({ kind: "schedule", scheduleId: schedule.id })}
              title={health.detail}
            >
              <strong>{schedule.name}</strong>
              <small>{health.label}</small>
            </button>
          ))}
        </div>
      )}
      <div className="overviewCardList overviewSupportList scheduleUpcomingList">{!canView ? (
        <OverviewCardState title="Schedules unavailable" message="View schedules permission is required." icon={<AppIcon name="shield" />} />
      ) : schedules.length === 0 ? (
        <OverviewCardState
          title="No schedules configured"
          message="Create recurring console actions from Schedules."
          icon={<SidebarIcon name="schedule" />}
          onClick={() => onOpenSchedules()}
          ariaLabel="Open Schedules to create a schedule"
        />
      ) : activeRuns.length === 0 && snapshot.schedules.length === 0 ? (
        <OverviewCardState
          title="No upcoming schedules"
          icon={<SidebarIcon name="schedule" />}
          onClick={() => onOpenSchedules()}
          ariaLabel="Open Schedules, no upcoming schedules"
        />
      ) : (
        <>
          {visibleActiveRuns.map(({ schedule, run }) => {
            const duration = formatActiveScheduleDuration(run.startedAt, now);
            const status = activeScheduleStatus(run);
            return (
              <button
                key={`active:${run.id}`}
                type="button"
                className="overviewCardRow overviewSupportListItem scheduleUpcomingItem scheduleActiveItem"
                onClick={() => onOpenSchedules({ kind: "active-run", scheduleId: schedule.id, runId: run.id })}
                title={`Open ${schedule.name}, ${status}, running for ${duration}`}
              >
                <span className="overviewSupportListIcon scheduleActiveIcon" aria-hidden="true"><SidebarIcon name="schedule" /><i /></span>
                <span className="overviewSupportListCopy">
                  <strong title={schedule.name}>{schedule.name}</strong>
                  <small><span>{status}</span><span aria-hidden="true">·</span><time dateTime={run.startedAt} title={formatDate(run.startedAt)}>{duration}</time></small>
                </span>
                <AppIcon name="chevronRight" />
              </button>
            );
          })}
          {visibleUpcomingSchedules.map((schedule) => {
          const nextRunAt = schedule.nextRunAt!;
          const nextTime = relativeTimestamps ? formatRelativeScheduleTime(nextRunAt, new Date(now)) : formatDate(nextRunAt);
          return (
            <button
              key={schedule.id}
              type="button"
              className="overviewCardRow overviewSupportListItem scheduleUpcomingItem"
              onClick={() => onOpenSchedules({ kind: "schedule", scheduleId: schedule.id })}
              title={`Open ${schedule.name}, next run ${nextTime}`}
            >
              <span className="overviewSupportListIcon" aria-hidden="true"><SidebarIcon name="schedule" /></span>
              <span className="overviewSupportListCopy">
                <strong title={schedule.name}>{schedule.name}</strong>
                <small><time dateTime={nextRunAt} title={formatDate(nextRunAt)}>{nextTime}</time></small>
              </span>
              <AppIcon name="chevronRight" />
            </button>
          );
          })}
        </>
      )}</div>
      {canView && hiddenScheduleCount > 0 && (
        <Button
          variant="ghost"
          compact
          className="overviewSupportMore scheduleUpcomingMore"
          onClick={() => onOpenSchedules()}
        >
          View {hiddenScheduleCount} more
        </Button>
      )}
    </OverviewCard>
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
  return formatRelativeTimestamp(date, now);
}

type RecentEventKind = EventIconKind;
export type ServerEventCategory = "player" | "server" | "automation";
type ServerEventFilter = "all" | ServerEventCategory;

const serverEventFilters: Array<{ id: ServerEventFilter; label: string }> = [
  { id: "all", label: "All events" },
  { id: "player", label: "Player activity" },
  { id: "server", label: "Server events" },
  { id: "automation", label: "Automation runs" }
];

export function serverEventCategory(event: ServerEvent): ServerEventCategory {
  if (event.eventType === "automation_run") return "automation";
  if (event.eventType === "player_joined" || event.eventType === "player_left") return "player";
  return "server";
}

function serverEventCategoryLabel(category: ServerEventCategory) {
  if (category === "player") return "Player activity";
  if (category === "automation") return "Automation run";
  return "Server event";
}

/** Event kinds whose subject is a player name, so the row can show that player's head. */
const playerHeadEventKinds = new Set<RecentEventKind>(["player_joined", "player_left", "player_reconnected"]);
/** Kinds that always collapse into one row, so an occurrence count would be misleading. */
const uncountedEventKinds = new Set<RecentEventKind>(["player_reconnected", "server_restarted"]);

type RecentEventGroup = {
  id: string;
  kind: RecentEventKind;
  severity: ServerEvent["severity"];
  title: string;
  details?: string;
  timestamp?: string;
  events: ServerEvent[];
};

function secondsBetween(first: ServerEvent, second: ServerEvent, now: Date) {
  const firstDate = eventDate(first.timestamp, now);
  const secondDate = eventDate(second.timestamp, now);
  if (!firstDate || !secondDate) return null;
  return Math.abs(firstDate.getTime() - secondDate.getTime()) / 1000;
}

function defaultEventDetails(event: ServerEvent) {
  if (event.eventType === "server_started") return undefined;
  if (event.details) return event.details;
  if (event.eventType === "player_left" && event.severity === "warning") return "The connection was lost";
  if (event.eventType === "mod_disabled") return "Review the mod configuration before the next restart";
  if (event.eventType === "server_crashed") return "Open the console or crash reports for the cause";
  return undefined;
}

function restartDowntimeDetails(duration: number) {
  if (duration < 2) return "Back online in under 2 seconds";
  if (duration < 60) return `Back online after ${Math.round(duration)} seconds`;
  const minutes = Math.round(duration / 6) / 10;
  return `Back online after ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

function restartDetails(stopped: ServerEvent, duration: number) {
  const purpose = stopped.details?.trim();
  return [purpose, restartDowntimeDetails(duration)].filter(Boolean).join(" · ");
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
      && samePlayerName(playerEventSubject(event), playerEventSubject(next))
      && duration !== null
      && duration * 1_000 <= playerReconnectWindowMs
    ) {
      const player = playerEventSubject(event);
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
        details: restartDetails(next, duration),
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

export function recentEventPresentation(group: RecentEventGroup) {
  const playerEvent = group.events[0];
  const player = playerEventSubject(playerEvent) || group.title.replace(/\s+(?:joined|left|reconnected)$/i, "").trim();
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

function RelatedEventsTooltip({
  group,
  formatDate
}: {
  group: RecentEventGroup;
  formatDate: (value: string | number | Date) => string;
}) {
  const label = relatedEventLabel(group);
  if (!label) return null;
  const events = [...group.events].sort((left, right) => {
    const leftTime = eventDate(left.timestamp)?.getTime() ?? 0;
    const rightTime = eventDate(right.timestamp)?.getTime() ?? 0;
    return leftTime - rightTime;
  });

  return (
    <HelpTooltip
      className="serverEventRelatedTooltip"
      label={label}
      trigger={<span className="eventCount">{label}</span>}
    >
      <span className="serverEventRelatedList">
        {events.map((event) => {
          const timestamp = eventDate(event.timestamp);
          const details = defaultEventDetails(event);
          return (
            <span className="serverEventRelatedItem" key={event.id}>
              <span className="serverEventRelatedHeading">
                <strong>{event.text}</strong>
                {timestamp && <time dateTime={timestamp.toISOString()}>{formatDate(timestamp)}</time>}
              </span>
              {details && <small>{details}</small>}
            </span>
          );
        })}
      </span>
    </HelpTooltip>
  );
}

export function RecentEventsPanel({
  events,
  eventsStatus = "ok",
  formatDate,
  relativeTimestamps = true,
  serverId = "",
  playerHeadsEnabled = false,
  onOpenConsole,
  loading = false
}: {
  events: ServerEvent[];
  eventsStatus?: "ok" | "unavailable";
  formatDate: (value: string | number | Date) => string;
  relativeTimestamps?: boolean;
  serverId?: string;
  playerHeadsEnabled?: boolean;
  onOpenConsole: () => void;
  loading?: boolean;
}) {
  const [filter, setFilter] = useState<ServerEventFilter>("all");
  const [page, setPage] = useState(0);
  const [sorting, setSorting] = useState<SortingState>([{ id: "timestamp", desc: true }]);
  const [now, setNow] = useState(() => new Date());
  const groupedEvents = useMemo(() => groupRecentEvents(events, now), [events, now]);
  const filteredEvents = useMemo(() => filter === "all"
    ? groupedEvents
    : groupedEvents.filter((group) => serverEventCategory(group.events[0]) === filter), [filter, groupedEvents]);
  const columns = useMemo<ColumnDef<RecentEventGroup>[]>(() => [
    {
      id: "event",
      accessorFn: (group) => {
        const presentation = recentEventPresentation(group);
        return `${presentation.title} ${presentation.subject ?? ""}`.trim();
      },
      header: "Event"
    },
    {
      id: "category",
      accessorFn: (group) => serverEventCategoryLabel(serverEventCategory(group.events[0])),
      header: "Category"
    },
    {
      id: "details",
      accessorFn: (group) => recentEventPresentation(group).details ?? relatedEventLabel(group) ?? "",
      header: "Purpose / details"
    },
    {
      id: "timestamp",
      accessorFn: (group) => eventDate(group.timestamp, now)?.getTime() ?? 0,
      header: "Time"
    }
  ], [now]);
  const tableData = useMemo(() => [...filteredEvents], [filteredEvents]);
  const table = useReactTable({
    data: tableData,
    columns,
    getRowId: (group) => group.id,
    state: { sorting },
    onSortingChange: (updater) => {
      setSorting(updater);
      setPage(0);
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });
  const rows = table.getRowModel().rows;
  const pages = Math.max(1, Math.ceil(rows.length / serverEventsPageSize));
  const currentPage = Math.min(page, pages - 1);
  const pageRows = rows.slice(currentPage * serverEventsPageSize, currentPage * serverEventsPageSize + serverEventsPageSize);
  const headVersion = playerHeadVersion(now.getTime());
  const filterCounts = useMemo(() => groupedEvents.reduce<Record<ServerEventCategory, number>>((counts, group) => {
    counts[serverEventCategory(group.events[0])] += 1;
    return counts;
  }, { player: 0, server: 0, automation: 0 }), [groupedEvents]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => setPage(0), [filter, serverId]);

  return (
    <OverviewCard
      className="eventsPanel"
      title="Server events"
      actions={<Button variant="ghost" compact className="textLinkButton" onClick={onOpenConsole}>View full log</Button>}
      loading={loading}
    >
      <div className="serverEventsBody">
        <div className="serverEventFilters" role="group" aria-label="Filter server events">
          {serverEventFilters.map((option) => {
            const count = option.id === "all" ? groupedEvents.length : filterCounts[option.id];
            return (
              <Button
                key={option.id}
                variant="ghost"
                compact
                className={filter === option.id ? "active" : undefined}
                aria-pressed={filter === option.id}
                onClick={() => setFilter(option.id)}
              >
                {option.label}<span className="serverEventFilterCount">{count}</span>
              </Button>
            );
          })}
        </div>
        {loading && <LoadingLabel>Loading server events</LoadingLabel>}
        {loading ? (
          <div className="serverEventsSkeleton" aria-hidden="true">
            {Array.from({ length: 5 }, (_, index) => (
              <div className="eventSkeletonRow" key={index}>
                <SkeletonBlock className="eventMarkerSkeleton" />
                <SkeletonBlock className="eventTextSkeleton" />
                <SkeletonBlock className="eventTimeSkeleton" />
              </div>
            ))}
          </div>
        ) : rows.length ? (
          <div className="serverEventsTableViewport uiTableViewport">
            <table className="serverEventsTable uiDataTable" aria-label="Server events">
              <thead className="uiTableHeader">
                <tr>
                  {table.getHeaderGroups()[0]?.headers.map((header) => (
                    <th key={header.id} scope="col" aria-sort={headerAriaSort(header)}>
                      <SortHeaderButton header={header}>
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </SortHeaderButton>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row) => {
                  const group = row.original;
                  const timestamp = eventDate(group.timestamp, now);
                  const presentation = recentEventPresentation(group);
                  const playerName = playerHeadEventKinds.has(group.kind) ? presentation.subject : undefined;
                  const occurrenceCount = group.events.length > 1 && !uncountedEventKinds.has(group.kind) ? group.events.length : 0;
                  const category = serverEventCategory(group.events[0]);
                  return (
                    <tr className={`serverEventRow ${group.severity} eventKind--${group.kind} uiTableRow`} key={group.id}>
                      <th scope="row">
                        <span className="serverEventIdentity">
                          <RecentEventMarker
                            kind={group.kind}
                            playerName={playerName}
                            serverId={serverId}
                            playerHeadsEnabled={playerHeadsEnabled}
                            version={headVersion}
                          >
                            {occurrenceCount > 0 && <span className="eventOccurrenceBadge">×{occurrenceCount}</span>}
                          </RecentEventMarker>
                          <span className="eventCopy">
                            <strong>{presentation.title}</strong>
                            {presentation.subject && <small className="eventSubject" title={presentation.subject}>{presentation.subject}</small>}
                            {occurrenceCount > 0 && <span className="srOnly">{occurrenceCount} occurrences</span>}
                          </span>
                        </span>
                      </th>
                      <td><span className={`serverEventCategory tone-${category}`}>{serverEventCategoryLabel(category)}</span></td>
                      <td className="serverEventDetails">
                        <span title={presentation.details}>{presentation.details || "—"}</span>
                        <RelatedEventsTooltip group={group} formatDate={formatDate} />
                      </td>
                      <td className="serverEventTime">
                        <time dateTime={timestamp?.toISOString()} title={relativeTimestamps && timestamp ? formatDate(timestamp) : undefined}>
                          {relativeTimestamps ? formatRelativeEventTime(group.timestamp, now) : timestamp ? formatDate(timestamp) : group.timestamp ? "Unknown" : "No timestamp"}
                        </time>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : eventsStatus === "unavailable" ? (
          <InlineState
            tone="warning"
            title="Events are unavailable"
            message="Open the console to inspect raw logs, or try again after the server writes new output."
            actionLabel="View full log"
            onAction={onOpenConsole}
          />
        ) : (
          <EmptyState
            compact
            className="eventEmpty"
            title={filter !== "all" && groupedEvents.length > 0 ? `No ${serverEventFilters.find((option) => option.id === filter)?.label.toLowerCase()} yet` : "No server events yet"}
            message={filter !== "all" && groupedEvents.length > 0 ? "Choose another filter to view the rest of the event history." : undefined}
          />
        )}
        {!loading && <TablePagination
          pageIndex={currentPage}
          pageSize={serverEventsPageSize}
          totalItems={rows.length}
          itemLabel="events"
          onPageChange={setPage}
        />}
      </div>
    </OverviewCard>
  );
}

function RecentEventMarker({
  kind,
  playerName,
  serverId,
  playerHeadsEnabled,
  version,
  children
}: {
  kind: RecentEventKind;
  playerName?: string;
  serverId: string;
  playerHeadsEnabled: boolean;
  version: number;
  children?: ReactNode;
}) {
  const { source, showHead, onHeadError } = usePlayerHead(serverId, playerName, version, playerHeadsEnabled);
  return (
    <span className={`eventIcon${showHead ? " eventIcon--withPlayerHead" : ""}`} aria-hidden="true">
      {showHead ? (
        <>
          <img
            className="eventPlayerHead"
            src={source}
            alt=""
            loading="lazy"
            decoding="async"
            onError={onHeadError}
          />
          <span className="eventPlayerIconBadge">
            <EventIcon kind={kind} />
          </span>
        </>
      ) : <EventIcon kind={kind} />}
      {children}
    </span>
  );
}
