import { useRef, type ChangeEvent, type FormEvent, type RefObject } from "react";
import type { ModInstallModalState } from "../app/uiState";
import type { InstalledMod, ModrinthHit, ModrinthInstallVersion, ReleaseChannel } from "../types";
import { AppIcon } from "../components/FileTypeIcon";
import { InlineState } from "../components/InlineState";
import { AddModsWorkflow } from "../features/mods/AddModsWorkflow";
import { InstalledModsList } from "../features/mods/InstalledModsList";
import { ModDetailsPanel } from "../features/mods/ModDetailsPanel";
import { ModsSummary } from "../features/mods/ModsSummary";

type Props = {
  serverName: string;
  minecraftVersion: string;
  mods: InstalledMod[];
  loading: boolean;
  error: string;
  installedQuery: string;
  addOpen: boolean;
  detailsMod: InstalledMod | null;
  serverRunning: boolean;
  changesAllowed: boolean;
  locked: boolean;
  toggleLocked: boolean;
  canStopServer: boolean;
  stoppingServer: boolean;
  modrinthConfigured: boolean;
  addDisabled: boolean;
  addDisabledReason: string;
  uploadDisabled: boolean;
  uploadDisabledReason: string;
  searchQuery: string;
  searchResults: ModrinthHit[];
  searchTotal: number;
  searching: boolean;
  loadingMore: boolean;
  searchError: string;
  versionsUnknown: boolean;
  contextMessage: string;
  sentinelRef: RefObject<HTMLDivElement | null>;
  installState: ModInstallModalState | null;
  selectedVersion: ModrinthInstallVersion | null;
  dependencyCount: number;
  canContinueInstall: boolean;
  formatDate: (value: string | number | Date) => string;
  formatNumber: (value: number) => string;
  onInstalledQueryChange: (value: string) => void;
  onOpenAdd: () => void;
  onCloseAdd: () => void;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
  onRefresh: () => void;
  onRetry: () => void;
  onStopServer: () => void;
  onToggle: (mod: InstalledMod, enabled: boolean) => void;
  onUpdate: (mod: InstalledMod) => void;
  onDetails: (mod: InstalledMod | null) => void;
  onRemove: (mod: InstalledMod) => void;
  onSearchQueryChange: (value: string) => void;
  onSearch: (event: FormEvent) => void;
  onChooseMod: (mod: ModrinthHit) => void;
  onInstallClose: () => void;
  onChannelChange: (mod: ModrinthHit, channel: ReleaseChannel) => void;
  onSelectVersion: (version: ModrinthInstallVersion) => void;
  onToggleAdvanced: () => void;
  onAcknowledge: (checked: boolean) => void;
  onContinueInstall: () => void;
  onBackInstall: () => void;
  onInstall: () => void;
};

export function ModsPage(props: Props) {
  const uploadRef = useRef<HTMLInputElement>(null);
  return (
    <section className="tabPage modsWorkspacePage">
      <header className="modsWorkspaceHeader"><div><h1>Mods</h1><p>Manage installed mods and add compatible Fabric mods.</p></div><span className="modsWorkspaceTarget">Fabric · Minecraft {props.minecraftVersion}</span></header>
      {props.serverRunning && <section className="modsLockBanner"><span><AppIcon name="shield" /></span><div><strong>Stop the server to change mods.</strong><p>Installs, uploads, removals, updates, and enable or disable changes require the server to be stopped.</p></div>{props.canStopServer && <button type="button" className="secondaryButton" onClick={props.onStopServer} disabled={props.stoppingServer}>{props.stoppingServer ? "Stopping…" : "Stop server"}</button>}</section>}
      {!props.modrinthConfigured && <section className="systemBanner accent"><strong>Modrinth search is unavailable.</strong><span>Installed mod management still works. Add an API key in Settings to search and install mods.</span></section>}
      <ModsSummary mods={props.mods} serverRunning={props.serverRunning} changesAllowed={props.changesAllowed} />
      <div className="modsWorkspaceToolbar">
        <div><button type="button" onClick={props.onOpenAdd} disabled={props.addDisabled} title={props.addDisabledReason}><AppIcon name="plus" /> Add mods</button><button type="button" className="secondaryButton" onClick={() => uploadRef.current?.click()} disabled={props.uploadDisabled} title={props.uploadDisabledReason}><AppIcon name="fileUp" /> Upload jar</button><button type="button" className="secondaryButton" onClick={props.onRefresh} disabled={props.loading}><AppIcon name="refresh" /> {props.loading ? "Checking…" : "Check updates"}</button></div>
        <span>{props.serverName}</span>
      </div>
      <input ref={uploadRef} className="hiddenInput" type="file" accept=".jar" onChange={props.onUpload} />
      {props.loading && props.mods.length === 0 && <InlineState tone="loading" title="Loading installed mods" message="Checking the mods folder and compatibility information." />}
      {props.error && <InlineState tone="error" title="Could not load installed mods" message={props.error} actionLabel="Retry" onAction={props.onRetry} busy={props.loading} />}
      <InstalledModsList mods={props.mods} query={props.installedQuery} busy={props.loading} locked={props.toggleLocked} onQueryChange={props.onInstalledQueryChange} onToggle={props.onToggle} onUpdate={props.onUpdate} onDetails={(mod) => props.onDetails(mod)} />
      {(props.addOpen || props.detailsMod) && <div className="modsDrawerBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) props.addOpen ? props.onCloseAdd() : props.onDetails(null); }}>
        {props.addOpen && <aside className="modsWorkflowDrawer" role="dialog" aria-modal="true" aria-label="Add mods"><AddModsWorkflow query={props.searchQuery} results={props.searchResults} total={props.searchTotal} installedMods={props.mods} searching={props.searching} loadingMore={props.loadingMore} error={props.searchError} configured={props.modrinthConfigured} versionsUnknown={props.versionsUnknown} contextMessage={props.contextMessage} locked={props.locked} sentinelRef={props.sentinelRef} installState={props.installState} selectedVersion={props.selectedVersion} dependencyCount={props.dependencyCount} canContinue={props.canContinueInstall} formatDate={props.formatDate} formatNumber={props.formatNumber} onClose={props.onCloseAdd} onQueryChange={props.onSearchQueryChange} onSearch={props.onSearch} onChoose={props.onChooseMod} onInstallClose={props.onInstallClose} onChannelChange={props.onChannelChange} onSelectVersion={props.onSelectVersion} onToggleAdvanced={props.onToggleAdvanced} onAcknowledge={props.onAcknowledge} onContinue={props.onContinueInstall} onBack={props.onBackInstall} onInstall={props.onInstall} /></aside>}
        {props.detailsMod && <ModDetailsPanel mod={props.detailsMod} locked={props.locked} formatDate={props.formatDate} onClose={() => props.onDetails(null)} onToggle={props.onToggle} onUpdate={props.onUpdate} onRemove={props.onRemove} />}
      </div>}
    </section>
  );
}
