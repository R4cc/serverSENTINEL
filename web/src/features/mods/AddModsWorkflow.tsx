import type { RefObject } from "react";
import type { ModInstallModalState } from "../../app/uiState";
import type { InstalledMod, ModrinthHit, ModrinthInstallVersion, ReleaseChannel } from "../../types";
import { AppIcon } from "../../components/FileTypeIcon";
import { InlineState } from "../../components/InlineState";
import { Button, EmptyState } from "../../components/UiPrimitives";
import { modIconSource } from "../../utils/appHelpers";
import { getSearchResultHealth } from "./modHealth";
import { ModInstallReview } from "./ModInstallReview";
import { ModStatusBadge } from "./ModStatusBadge";

type Props = {
  query: string;
  results: ModrinthHit[];
  total: number;
  installedMods: InstalledMod[];
  searching: boolean;
  loadingMore: boolean;
  error: string;
  configured: boolean;
  versionsUnknown: boolean;
  contextMessage: string;
  locked: boolean;
  sentinelRef: RefObject<HTMLDivElement | null>;
  installState: ModInstallModalState | null;
  selectedVersion: ModrinthInstallVersion | null;
  requiredDependencies: ModrinthInstallVersion["dependencies"];
  canContinue: boolean;
  formatDate: (value: string | number | Date) => string;
  formatNumber: (value: number) => string;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onChoose: (mod: ModrinthHit) => void;
  onRetrySearch: () => void;
  onInstallClose: () => void;
  onChannelChange: (mod: ModrinthHit, channel: ReleaseChannel) => void;
  onSelectVersion: (version: ModrinthInstallVersion) => void;
  onToggleAdvanced: () => void;
  onAcknowledge: (checked: boolean) => void;
  onContinue: () => void;
  onBack: () => void;
  onInstall: () => void;
};

export function AddModsWorkflow(props: Props) {
  if (props.installState) {
    return <ModInstallReview state={props.installState} selected={props.selectedVersion} requiredDependencies={props.requiredDependencies} canContinue={props.canContinue} formatDate={props.formatDate} onClose={props.onInstallClose} onChannelChange={(channel) => props.onChannelChange(props.installState!.mod, channel)} onRetry={() => props.onChannelChange(props.installState!.mod, props.installState!.channel)} onSelect={props.onSelectVersion} onToggleAdvanced={props.onToggleAdvanced} onAcknowledge={props.onAcknowledge} onContinue={props.onContinue} onBack={props.onBack} onInstall={props.onInstall} />;
  }

  const installedIds = new Set(props.installedMods.map((mod) => mod.modrinth?.projectId).filter(Boolean));
  return (
    <div className="modsAddWorkflow">
      <div className="modsDrawerHeader">
        <div><small>Add mods</small><h2>Find a Fabric mod</h2><p>Results are matched to this server automatically.</p></div>
        <Button variant="secondary" iconOnly className="iconButton" onClick={props.onClose} aria-label="Close add mods"><AppIcon name="x" /></Button>
      </div>
      <div className="modsDrawerBody">
        <div className="modsAddSearch">
          <label><AppIcon name="search" /><span className="srOnly">Search</span><input autoFocus value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} placeholder="Search by mod name…" disabled={!props.configured || props.versionsUnknown} /></label>
          <span className="modsSearchActivity" aria-live="polite">{props.searching ? "Searching…" : props.query.trim() ? "Results update as you type" : ""}</span>
        </div>
        <div className="modsSafeSearchNote"><AppIcon name="shield" /><span>Compatible Fabric server mods appear first.</span></div>
        {!props.configured && <InlineState tone="error" title="Modrinth is not configured" message="Add a Modrinth API key in Settings to search and install mods." />}
        {props.versionsUnknown && <InlineState tone="error" title="Server version unknown" message={props.contextMessage} />}
        {props.error && <InlineState tone="error" title="Search failed" message={props.error} actionLabel="Refresh" onAction={props.onRetrySearch} busy={props.searching} />}
        {!props.searching && props.configured && !props.versionsUnknown && !props.query.trim() && <EmptyState compact className="modsWorkspaceEmpty" title="What would you like to add?" message="Search Modrinth and ServerSentinel will recommend the safest release." />}
        {!props.searching && props.query.trim() && !props.error && props.results.length === 0 && <EmptyState compact className="modsWorkspaceEmpty" title="No matching mods" message="Try a shorter or different search." />}
        <div className="modsSearchResults" aria-busy={props.searching}>
          {props.searching && Array.from({ length: 4 }, (_, index) => <div key={index} className="modsResultCard isSkeleton" aria-hidden="true" />)}
          {!props.searching && props.results.map((mod) => {
            const health = getSearchResultHealth(mod);
            const installed = installedIds.has(mod.project_id);
            const icon = modIconSource(mod.icon_url);
            return (
              <article key={mod.project_id} className="modsResultCard">
                {icon ? <img src={icon} alt="" /> : <span className="modsWorkspaceFallback">MOD</span>}
                <div className="modsResultContent"><div><strong>{mod.title}</strong><ModStatusBadge tone={health.tone}>{health.label}</ModStatusBadge></div><p>{mod.description}</p><small>{props.formatNumber(mod.downloads)} downloads{mod.date_modified ? ` · Updated ${props.formatDate(mod.date_modified)}` : ""}</small></div>
                <Button variant={health.safeToRunDirectly ? "primary" : "secondary"} compact onClick={() => props.onChoose(mod)} disabled={installed || props.locked}>{installed ? "Installed" : health.primaryActionLabel}</Button>
              </article>
            );
          })}
          {props.loadingMore && <div className="modsResultCard isSkeleton" aria-hidden="true" />}
          {props.results.length > 0 && props.results.length < props.total && <div ref={props.sentinelRef} className="modsSearchSentinel" />}
        </div>
      </div>
    </div>
  );
}
