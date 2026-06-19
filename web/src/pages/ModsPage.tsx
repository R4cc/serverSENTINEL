import { useRef } from "react";
import { AppIcon } from "../components/FileTypeIcon";
import { InlineState } from "../components/InlineState";
import { AddModsWorkflow } from "../features/mods/AddModsWorkflow";
import { InstalledModsList } from "../features/mods/InstalledModsList";
import { ModDetailsPanel } from "../features/mods/ModDetailsPanel";
import { ModsSummary } from "../features/mods/ModsSummary";
import type { ModsWorkspaceController } from "../features/mods/useModsWorkspace";
import { canUpdateAllSafe, updatePlanEntryForMod } from "../features/mods/modUpdatePlan";

export type ModsPageServerContext = {
  minecraftVersion: string;
  versionsUnknown: boolean;
  contextMessage: string;
};

export type ModsPageAccess = {
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
};

type Props = {
  workspace: ModsWorkspaceController;
  serverContext: ModsPageServerContext;
  access: ModsPageAccess;
  formatters: {
    date: (value: string | number | Date) => string;
    number: (value: number) => string;
  };
  onStopServer: () => void;
};

export function ModsPage({ workspace, serverContext, access, formatters, onStopServer }: Props) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const { data, state, derived, refs, actions } = workspace;
  const canRunSafeBatch = canUpdateAllSafe(data.updatePlan, access.changesAllowed, state.batchUpdateRunning);
  const showSafeBatch = Boolean(data.updatePlan?.counts.safeUpdates && (access.changesAllowed || state.batchUpdateRunning));
  const updateCheckWaitingForMods = state.modsLoading && !state.updatePlanLoading;
  const isTransientModrinthError = (message: string) => /Modrinth request failed:\s*5\d\d\b/i.test(message);
  const visibleModsError = state.modsError && !isTransientModrinthError(state.modsError) ? state.modsError : "";
  const visibleUpdatePlanError = state.updatePlanError && !isTransientModrinthError(state.updatePlanError) ? state.updatePlanError : "";

  return (
    <section className="tabPage modsWorkspacePage">
      {access.serverRunning && <section className="modsLockBanner"><span><AppIcon name="shield" /></span><div><strong>Stop the server to change mods.</strong><p>Installs, uploads, removals, updates, and enable or disable changes require the server to be stopped.</p></div>{access.canStopServer && <button type="button" className="secondaryButton" onClick={onStopServer} disabled={access.stoppingServer}>{access.stoppingServer ? "Stopping…" : "Stop server"}</button>}</section>}
      {!access.modrinthConfigured && <section className="systemBanner accent"><strong>Modrinth search is unavailable.</strong><span>Installed mod management still works. Add an API key in Settings to search and install mods.</span></section>}
      <ModsSummary mods={data.installedMods} updatePlan={data.updatePlan} />
      <div className="modsWorkspaceToolbar">
        <div className="modsWorkspacePrimaryActions"><button type="button" onClick={actions.openAdd} disabled={access.addDisabled} title={access.addDisabledReason}><AppIcon name="plus" /> Add mods</button><button type="button" className="secondaryButton" onClick={() => uploadRef.current?.click()} disabled={access.uploadDisabled} title={access.uploadDisabledReason}><AppIcon name="fileUp" /> Upload jar</button></div>
        <div className="modsWorkspaceUpdateActions"><button type="button" className="secondaryButton" onClick={() => { if (!updateCheckWaitingForMods) void actions.refresh(); }} disabled={state.updatePlanLoading} aria-disabled={updateCheckWaitingForMods || state.updatePlanLoading} title={updateCheckWaitingForMods ? "Waiting for the current mod change to finish." : state.updatePlanLoading ? "Checking installed mods for updates." : "Check installed mods for updates."}><AppIcon name="refresh" /> {state.updatePlanLoading ? "Checking…" : "Check updates"}</button>{showSafeBatch && <button type="button" onClick={() => void actions.updateAllSafe()} disabled={!canRunSafeBatch}>{state.batchUpdateRunning ? "Updating safe mods…" : `Update all safe (${data.updatePlan?.counts.safeUpdates})`}</button>}</div>
      </div>
      <input ref={uploadRef} className="hiddenInput" type="file" accept=".jar" onChange={actions.uploadMod} />
      {state.modsLoading && data.installedMods.length === 0 && <InlineState tone="loading" title="Loading installed mods" message="Checking the mods folder and compatibility information." />}
      {visibleModsError && <InlineState tone="error" title="Could not load installed mods" message={visibleModsError} actionLabel="Retry" onAction={actions.retry} busy={state.modsLoading} />}
      {visibleUpdatePlanError && <InlineState tone="error" title="Could not check updates" message={visibleUpdatePlanError} actionLabel="Retry" onAction={() => void actions.refresh()} busy={state.updatePlanLoading} />}
      <InstalledModsList mods={data.installedMods} query={state.installedQuery} busy={state.modsLoading} locked={access.toggleLocked} onQueryChange={actions.setInstalledQuery} onToggle={actions.setInstalledModEnabled} onUpdate={actions.updateMod} onDetails={actions.setDetailsMod} updatePlan={data.updatePlan} />
      {(state.addOpen || state.detailsMod) && <div className="modsDrawerBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) state.addOpen ? actions.closeAdd() : actions.setDetailsMod(null); }}>
        {state.addOpen && <aside className="modsWorkflowDrawer" role="dialog" aria-modal="true" aria-label="Add mods"><AddModsWorkflow query={state.query} results={data.searchResults} total={data.searchTotal} installedMods={data.installedMods} searching={state.searching} loadingMore={state.loadingMore} error={state.searchError} configured={access.modrinthConfigured} versionsUnknown={serverContext.versionsUnknown} contextMessage={serverContext.contextMessage} locked={access.locked} sentinelRef={refs.sentinelRef} installState={state.installState} selectedVersion={derived.selectedVersion} requiredDependencies={derived.pendingDependencies} canContinue={derived.canContinueInstall} formatDate={formatters.date} formatNumber={formatters.number} onClose={actions.closeAdd} onQueryChange={actions.setQuery} onChoose={actions.openInstallReview} onInstallClose={actions.closeInstall} onChannelChange={(mod, channel) => void actions.loadInstallVersions(mod, channel)} onSelectVersion={actions.selectInstallVersion} onToggleAdvanced={actions.toggleAdvanced} onAcknowledge={actions.acknowledgeInstall} onContinue={actions.continueInstallReview} onBack={actions.backInstall} onInstall={actions.installSelectedMod} /></aside>}
        {state.detailsMod && <ModDetailsPanel mod={state.detailsMod} locked={access.locked} formatDate={formatters.date} onClose={() => actions.setDetailsMod(null)} onToggle={actions.setInstalledModEnabled} onUpdate={actions.updateMod} onRemove={actions.removeMod} updatePlanEntry={updatePlanEntryForMod(data.updatePlan, state.detailsMod)} />}
      </div>}
    </section>
  );
}
