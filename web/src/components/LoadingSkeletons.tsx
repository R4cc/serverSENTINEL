import { LoadingLabel, SkeletonBlock } from "./UiPrimitives";
import { BrandLogo } from "./BrandLogo";
import type { ActivePage } from "../types";

export function AuthLoadingSkeleton() {
  return (
    <main className="authShell">
      <section className="authPanel authLoadingSkeleton" aria-busy="true">
        <LoadingLabel>Checking session</LoadingLabel>
        <div className="brandLockup" aria-hidden="true">
          <BrandLogo />
          <div><SkeletonBlock className="authSkeletonTitle" /><SkeletonBlock className="authSkeletonSubtitle" /></div>
        </div>
        <div className="authSkeletonFields" aria-hidden="true">
          <SkeletonBlock className="authSkeletonLabel" /><SkeletonBlock className="authSkeletonInput" />
          <SkeletonBlock className="authSkeletonLabel" /><SkeletonBlock className="authSkeletonInput" />
          <SkeletonBlock className="authSkeletonButton" />
        </div>
      </section>
    </main>
  );
}

export function ApplicationLoadingSkeleton({ page = "overview" }: { page?: ActivePage }) {
  return (
    <section className={`tabPage applicationLoadingSkeleton applicationLoadingSkeleton--${page} ${page === "properties" || page === "create" ? "layoutReadable" : "layoutWide"}`} aria-busy="true">
      <LoadingLabel>Loading application</LoadingLabel>
      <ApplicationSkeletonContent page={page} />
    </section>
  );
}

function ApplicationSkeletonContent({ page }: { page: ActivePage }) {
  if (page === "overview") {
    return (
      <div className="applicationOverviewSkeleton" aria-hidden="true">
        <div className="applicationSkeletonSummary">
          {Array.from({ length: 7 }, (_, index) => <SkeletonBlock className={`applicationSkeletonTile ${index > 4 ? "applicationSkeletonWideTile" : ""}`} key={index} />)}
        </div>
        <div className="applicationOverviewPanelGrid">
          <SkeletonPanel className="applicationOverviewResourcePanel" rows={3} />
          <SkeletonPanel className="applicationOverviewPlayersPanel" rows={2} />
          <SkeletonPanel className="applicationOverviewModsPanel" rows={2} />
          <SkeletonPanel className="applicationOverviewAutomationPanel" rows={2} />
          <SkeletonPanel className="applicationOverviewEventsPanel" rows={3} />
        </div>
      </div>
    );
  }

  if (page === "files") {
    return (
      <div className="applicationFilesSkeleton" aria-hidden="true">
        <div className="applicationSkeletonPanel applicationFilesMainPanel">
          <div className="applicationFilesToolbar">
            <SkeletonBlock className="applicationSkeletonButtonGroup" />
            <SkeletonBlock className="applicationSkeletonBreadcrumb" />
            <SkeletonBlock className="applicationSkeletonButtonGroup applicationSkeletonButtonGroup--end" />
          </div>
          <SkeletonBlock className="applicationFilesSelectionBar" />
          <div className="applicationFilesRows">
            {Array.from({ length: 8 }, (_, index) => <SkeletonBlock className="applicationSkeletonRow applicationFilesRow" key={index} />)}
          </div>
        </div>
        <SkeletonPanel className="applicationFilesDetailsPanel" rows={5} />
      </div>
    );
  }

  if (page === "mods") {
    return (
      <div className="applicationModsSkeleton" aria-hidden="true">
        <div className="applicationModsSummary">
          {Array.from({ length: 3 }, (_, index) => <SkeletonBlock className="applicationModsMetric" key={index} />)}
        </div>
        <div className="applicationModsToolbar">
          <SkeletonBlock className="applicationSkeletonButtonGroup" />
          <SkeletonBlock className="applicationSkeletonButtonGroup applicationSkeletonButtonGroup--end" />
        </div>
        <div className="applicationSkeletonPanel applicationModsTable">
          <SkeletonBlock className="applicationSkeletonHeading" />
          {Array.from({ length: 6 }, (_, index) => <SkeletonBlock className="applicationSkeletonRow" key={index} />)}
        </div>
      </div>
    );
  }

  if (page === "console") {
    return (
      <div className="applicationConsoleSkeleton" aria-hidden="true">
        <div className="applicationConsoleHeader"><SkeletonBlock className="applicationSkeletonHeading" /><SkeletonBlock className="applicationSkeletonButton" /></div>
        <TerminalLoadingSkeleton />
      </div>
    );
  }

  if (page === "schedule") {
    return (
      <div className="applicationScheduleSkeleton" aria-hidden="true">
        <div className="applicationScheduleToolbar"><SkeletonBlock className="applicationSkeletonButtonGroup" /><SkeletonBlock className="applicationSkeletonBreadcrumb" /></div>
        <div className="applicationScheduleGrid">
          <SkeletonPanel rows={6} />
          <SkeletonPanel rows={4} />
        </div>
      </div>
    );
  }

  return <SkeletonPanel className="applicationFormSkeleton" rows={6} />;
}

function SkeletonPanel({ rows = 6, className = "" }: { rows?: number; className?: string }) {
  return (
    <div className={`applicationSkeletonPanel ${className}`.trim()}>
      <SkeletonBlock className="applicationSkeletonHeading" />
      {Array.from({ length: rows }, (_, index) => <SkeletonBlock className="applicationSkeletonRow" key={index} style={{ width: `${88 - (index % 3) * 9}%` }} />)}
    </div>
  );
}

export function ActiveServerStripLoadingSkeleton() {
  return (
    <div className="activeServerStrip activeServerStripLoadingSkeleton" aria-hidden="true">
      <div className="serverStripPrimary">
        <div className="serverStripLeft">
          <SkeletonBlock className="serverStripIcon serverStripLoadingIcon" />
          <div className="serverStripInfo">
            <div className="serverStripTitleRow">
              <SkeletonBlock className="serverStripLoadingTitle" />
              <SkeletonBlock className="serverStripLoadingBadge" />
            </div>
            <div className="serverStripMetaRow">
              <SkeletonBlock className="serverStripLoadingMeta" />
            </div>
          </div>
        </div>
        <div className="serverStripRight">
          <div className="runtimeControls runtimeControlsCompact">
            <SkeletonBlock className="runtimeControlButton serverStripLoadingButton" />
            <SkeletonBlock className="runtimeControlButton serverStripLoadingButton" />
          </div>
          <SkeletonBlock className="quickActionButton consoleLink serverStripLoadingButton" />
          <SkeletonBlock className="overflowButton serverStripLoadingOverflow" />
        </div>
      </div>
    </div>
  );
}

export function FeaturePageLoadingSkeleton({ label, page = "overview" }: { label: string; page?: ActivePage }) {
  return (
    <section className={`tabPage featurePageLoadingSkeleton applicationLoadingSkeleton applicationLoadingSkeleton--${page} ${page === "properties" || page === "create" ? "layoutReadable" : "layoutWide"}`} aria-busy="true">
      <LoadingLabel>{label}</LoadingLabel>
      <ApplicationSkeletonContent page={page} />
    </section>
  );
}

export function ResourcePanelLoadingSkeleton() {
  return (
    <section className="panel resourcePanel" aria-busy="true">
      <LoadingLabel>Loading resource usage</LoadingLabel>
      <div className="resourceRows resourceSkeletonRows" aria-hidden="true">
        {Array.from({ length: 3 }, (_, index) => (
          <div className="resourceRow" key={index}>
            <div className="resourceMetricLabel"><SkeletonBlock className="uiSkeleton--text" /><SkeletonBlock className="uiSkeleton--title" /><SkeletonBlock className="uiSkeleton--text" /></div>
            <SkeletonBlock className="resourceChartSkeleton" />
          </div>
        ))}
      </div>
    </section>
  );
}

export function CodeLoadingSkeleton({ label = "Loading content" }: { label?: string }) {
  return (
    <div className="codeLoadingSkeleton" aria-busy="true">
      <LoadingLabel>{label}</LoadingLabel>
      <div aria-hidden="true">
        {Array.from({ length: 12 }, (_, index) => <SkeletonBlock className="codeSkeletonLine" key={index} style={{ width: `${45 + (index * 23) % 50}%` }} />)}
      </div>
    </div>
  );
}

export function TerminalLoadingSkeleton() {
  return (
    <div className="terminalLoadingSkeleton" aria-busy="true">
      <LoadingLabel>Connecting to live console</LoadingLabel>
      <div aria-hidden="true">
        {Array.from({ length: 10 }, (_, index) => <SkeletonBlock className="terminalSkeletonLine" key={index} style={{ width: `${38 + (index * 29) % 56}%` }} />)}
      </div>
    </div>
  );
}
