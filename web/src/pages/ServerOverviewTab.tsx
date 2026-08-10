import { Suspense } from "react";
import { lazyPage } from "../app/lazyPage";
import type { ManagedServer, PlayerSnapshot, ScheduleNavigationTarget, ServerOverviewData, ServerStatus, ServerStorageSummary, ServerTimelineResourcePoint, ServerTimelineResponse } from "../types";
import type { ModUpdatePlan } from "../types";
import type { RequestConfirmation } from "../components/ConfirmationModal";
import { InlineState } from "../components/InlineState";
import { ServerTimelineLoadingSkeleton } from "../components/LoadingSkeletons";
import type { ManagedContentTerminology } from "../features/mods/contentTerminology";
import { useServerStorageSummary } from "../features/overview/useServerStorageSummary";
import { ActivePlayersPanel, ModHealthPanel, OverviewSummary, RecentEventsPanel, SchedulePanel } from "./OverviewPage";

const { Component: ServerTimeline, preload: loadServerTimeline } = lazyPage(
  () => import("../components/ServerTimeline"),
  (module) => module.ServerTimeline
);
export { loadServerTimeline };

/**
 * The overview dashboard. It stays mounted while the rest of the server workspace is browsed and
 * hides itself when another page is showing: the timeline builds three chart instances, and doing
 * that again on every visit costs more than everything else the page does put together.
 */
export function ServerOverviewTab({
  active,
  server,
  status,
  dockerSocketMounted,
  overviewData,
  overviewError,
  overviewLoading,
  overviewInitialLoading,
  onRetryOverview,
  timelineVisible,
  timelineLatestSample,
  onTimelineLatestSample,
  loadTimeline,
  loadStorageSummary,
  playerSnapshot,
  playerHeadsEnabled,
  modUpdatePlan,
  modUpdatePlanLoading,
  canViewMods,
  onOpenMods,
  onRefreshModUpdates,
  managedContent,
  canViewSchedules,
  onOpenSchedules,
  onOpenConsole,
  requestConfirmation,
  relativeTimestamps,
  formatDate,
  formatTime,
  formatShortTime
}: {
  active: boolean;
  server: ManagedServer;
  status: ServerStatus | null;
  dockerSocketMounted: boolean;
  overviewData: ServerOverviewData;
  overviewError: string;
  overviewLoading: boolean;
  overviewInitialLoading: boolean;
  onRetryOverview: () => void;
  timelineVisible: boolean;
  timelineLatestSample: ServerTimelineResourcePoint | undefined;
  onTimelineLatestSample: (sample?: ServerTimelineResourcePoint) => void;
  loadTimeline: (from: number, to: number, maxPoints: number) => Promise<ServerTimelineResponse>;
  loadStorageSummary: (serverId: string) => Promise<ServerStorageSummary>;
  playerSnapshot: PlayerSnapshot | undefined;
  playerHeadsEnabled: boolean;
  modUpdatePlan: ModUpdatePlan | null;
  modUpdatePlanLoading: boolean;
  canViewMods: boolean;
  onOpenMods: () => void;
  onRefreshModUpdates: () => void;
  managedContent: ManagedContentTerminology;
  canViewSchedules: boolean;
  onOpenSchedules: (target?: ScheduleNavigationTarget) => void;
  onOpenConsole: () => void;
  requestConfirmation: RequestConfirmation;
  relativeTimestamps: boolean;
  formatDate: (value: string | number | Date) => string;
  formatTime: (value: string | number | Date) => string;
  formatShortTime: (value: string | number | Date) => string;
}) {
  const storageSummary = useServerStorageSummary(server.id, active, loadStorageSummary);

  return (
    <section className="tabPage overviewPage layoutWide" hidden={!active}>
      {overviewError && (
        <InlineState
          tone="warning"
          title="Overview is not up to date"
          message={`${overviewError} Previously loaded activity is still shown when available.`}
          actionLabel="Retry"
          onAction={onRetryOverview}
          busy={overviewLoading}
        />
      )}
      <div className={`overviewDashboardGrid ${timelineVisible ? "overviewDashboardGrid--timeline" : "overviewDashboardGrid--chartless"}`}>
        <OverviewSummary
          server={server}
          status={status}
          dockerSocketMounted={dockerSocketMounted}
          activity={overviewData.activity}
          latestResourceSample={timelineVisible ? timelineLatestSample : undefined}
          worldSizeBytes={storageSummary.worldSizeBytes}
          storageAvailableBytes={storageSummary.availableBytes}
          storageTotalBytes={storageSummary.totalBytes}
          storageLoading={storageSummary.loading}
          loading={overviewInitialLoading}
        />

        {timelineVisible && (
          <Suspense fallback={<ServerTimelineLoadingSkeleton />}>
            <ServerTimeline
              key={server.id}
              loadTimeline={loadTimeline}
              formatTime={formatTime}
              formatShortTime={formatShortTime}
              formatDate={formatDate}
              serverId={server.id}
              playerHeadsEnabled={playerHeadsEnabled}
              onLatestSample={onTimelineLatestSample}
              onOpenSchedules={onOpenSchedules}
              paused={!active}
            />
          </Suspense>
        )}

        {!timelineVisible && (
          <ActivePlayersPanel
            snapshot={playerSnapshot}
            running={Boolean(status?.docker.running)}
            loading={overviewInitialLoading}
            serverId={server.id}
            playerHeadsEnabled={playerHeadsEnabled}
          />
        )}
        <div className="overviewSupportStack">
          <ModHealthPanel
            updatePlan={modUpdatePlan}
            loading={modUpdatePlanLoading}
            canView={canViewMods}
            onOpenMods={onOpenMods}
            onRefresh={onRefreshModUpdates}
            contentPlural={managedContent.plural}
            contentPluralTitle={managedContent.pluralTitle}
          />
          <SchedulePanel
            schedules={server.schedules ?? []}
            canView={canViewSchedules}
            formatDate={formatDate}
            relativeTimestamps={relativeTimestamps}
            onOpenSchedules={onOpenSchedules}
          />
        </div>
        <RecentEventsPanel
          events={overviewData.events}
          eventsStatus={overviewData.eventsStatus}
          formatDate={formatDate}
          relativeTimestamps={relativeTimestamps}
          serverId={server.id}
          playerHeadsEnabled={playerHeadsEnabled}
          onOpenConsole={onOpenConsole}
          requestConfirmation={requestConfirmation}
          loading={overviewLoading && overviewData.events.length === 0}
        />
      </div>
    </section>
  );
}
