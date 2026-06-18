import type { FormEvent, RefObject } from "react";
import type { ModInstallModalState } from "../../app/uiState";
import type { InstalledMod, ModrinthHit, ModrinthInstallVersion, ReleaseChannel } from "../../types";
import { AppIcon } from "../../components/FileTypeIcon";
import { InlineState } from "../../components/InlineState";
import { modIconSource } from "../../utils/appHelpers";
import { getSearchResultHealth } from "./modHealth";
import { ModInstallReview } from "./ModInstallReview";

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
  dependencyCount: number;
  canContinue: boolean;
  formatDate: (value: string | number | Date) => string;
  formatNumber: (value: number) => string;
  onClose: () => void;
  onQueryChange: (value: string) => void;
  onSearch: (event: FormEvent) => void;
  onChoose: (mod: ModrinthHit) => void;
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
    return <ModInstallReview state={props.installState} selected={props.selectedVersion} dependencyCount={props.dependencyCount} canContinue={props.canContinue} formatDate={props.formatDate} onClose={props.onInstallClose} onChannelChange={(channel) => props.onChannelChange(props.installState!.mod, channel)} onSelect={props.onSelectVersion} onToggleAdvanced={props.onToggleAdvanced} onAcknowledge={props.onAcknowledge} onContinue={props.onContinue} onBack={props.onBack} onInstall={props.onInstall} />;
  }

  const installedIds = new Set(props.installedMods.map((mod) => mod.modrinth?.projectId).filter(Boolean));
  return (
    <div className="modsAddWorkflow">
      <div className="modsDrawerHeader">
        <div><small>Add mods</small><h2>Find a Fabric mod</h2><p>Results are matched to this server automatically.</p></div>
        <button type="button" className="iconButton" onClick={props.onClose} aria-label="Close add mods"><AppIcon name="x" /></button>
      </div>
      <div className="modsDrawerBody">
        <form className="modsAddSearch" onSubmit={props.onSearch}>
          <label><AppIcon name="search" /><span className="srOnly">Search Modrinth</span><input autoFocus value={props.query} onChange={(event) => props.onQueryChange(event.target.value)} placeholder="Search by mod name…" disabled={!props.configured || props.versionsUnknown} /></label>
          <button type="submit" disabled={!props.query.trim() || props.searching || !props.configured || props.versionsUnknown}>{props.searching ? "Searching…" : "Search"}</button>
        </form>
        <div className="modsSafeSearchNote"><AppIcon name="shield" /><span>Showing Fabric server mods compatible with this server first.</span></div>
        {!props.configured && <InlineState tone="error" title="Modrinth is not configured" message="Add a Modrinth API key in Settings to search and install mods." />}
        {props.versionsUnknown && <InlineState tone="error" title="Server version unknown" message={props.contextMessage} />}
        {props.error && <InlineState tone="error" title="Search failed" message={props.error} />}
        {!props.searching && props.configured && !props.versionsUnknown && !props.query.trim() && <div className="modsWorkspaceEmpty"><strong>What would you like to add?</strong><span>Search Modrinth and ServerSentinel will recommend the safest release.</span></div>}
        {!props.searching && props.query.trim() && !props.error && props.results.length === 0 && <div className="modsWorkspaceEmpty"><strong>No matching mods</strong><span>Try a shorter or different search.</span></div>}
        <div className="modsSearchResults" aria-busy={props.searching}>
          {props.searching && Array.from({ length: 4 }, (_, index) => <div key={index} className="modsResultCard isSkeleton" aria-hidden="true" />)}
          {!props.searching && props.results.map((mod) => {
            const health = getSearchResultHealth(mod);
            const installed = installedIds.has(mod.project_id);
            const icon = modIconSource(mod.icon_url);
            return (
              <article key={mod.project_id} className="modsResultCard">
                {icon ? <img src={icon} alt="" /> : <span className="modsWorkspaceFallback">MOD</span>}
                <div className="modsResultContent"><div><strong>{mod.title}</strong><span className={`modsStatusChip ${health.tone}`}>{health.label}</span></div><p>{mod.description}</p><small>{props.formatNumber(mod.downloads)} downloads{mod.date_modified ? ` · Updated ${props.formatDate(mod.date_modified)}` : ""}</small></div>
                <button type="button" className={health.safeToRunDirectly ? "" : "secondaryButton"} onClick={() => props.onChoose(mod)} disabled={installed || props.locked}>{installed ? "Installed" : health.primaryActionLabel}</button>
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
