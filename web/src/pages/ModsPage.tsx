import { useRef } from "react";
import { AppIcon } from "../components/FileTypeIcon";
import { InlineState } from "../components/InlineState";
import { Button } from "../components/UiPrimitives";
import { AddModsWorkflow } from "../features/mods/AddModsWorkflow";
import { InstalledModsList } from "../features/mods/InstalledModsList";
import { ModDetailsPanel } from "../features/mods/ModDetailsPanel";
import { ModsSummary } from "../features/mods/ModsSummary";
import type { ModsWorkspaceController } from "../features/mods/useModsWorkspace";
import type { RestartRequiredChange } from "../types";
import { canUpdateAllSafe, updatePlanEntryForMod } from "../features/mods/modUpdatePlan";
import { DialogSurface } from "../components/DialogSurface";
import { formatRelativeTimestamp } from "../utils/format";
import { managedContentTerminology } from "../features/mods/contentTerminology";
import type { ServerRuntimeType } from "@serversentinel/contracts";

type ModsPageServerContext = {
  minecraftVersion: string;
  versionsUnknown: boolean;
  contextMessage: string;
};

type ModsPageAccess = {
  changesAllowed: boolean;
  locked: boolean;
  reviewAcknowledgementLocked: boolean;
  toggleLocked: boolean;
  modrinthConfigured: boolean;
  addDisabled: boolean;
  addDisabledReason: string;
  uploadDisabled: boolean;
  uploadDisabledReason: string;
};

type Props = {
  workspace: ModsWorkspaceController;
  runtimeType: ServerRuntimeType;
  restartRequiredChanges?: RestartRequiredChange[];
  serverContext: ModsPageServerContext;
  access: ModsPageAccess;
  relativeTimestamps: boolean;
  formatters: {
    date: (value: string | number | Date) => string;
    number: (value: number) => string;
  };
};

export function ModsPage({ workspace, runtimeType, restartRequiredChanges, serverContext, access, relativeTimestamps, formatters }: Props) {
  const uploadRef = useRef<HTMLInputElement>(null);
  const terminology = managedContentTerminology(runtimeType);
  const { data, state, derived, refs, actions } = workspace;
  const canRunSafeBatch = canUpdateAllSafe(data.updatePlan, access.changesAllowed, state.batchUpdateRunning);
  const showSafeBatch = Boolean(data.updatePlan?.counts.safeUpdates && (access.changesAllowed || state.batchUpdateRunning));
  const updateCheckWaitingForMods = state.modsLoading && !state.updatePlanLoading;
  const isTransientModrinthError = (message: string) => /Modrinth request failed:\s*5\d\d\b/i.test(message);
  const visibleModsError = state.modsError && !isTransientModrinthError(state.modsError) ? state.modsError : "";
  const visibleUpdatePlanError = state.updatePlanError && !isTransientModrinthError(state.updatePlanError) ? state.updatePlanError : "";

  return (
    <section className="tabPage modsWorkspacePage layoutWide">
      {!access.modrinthConfigured && <section className="systemBanner accent"><strong>Modrinth search is unavailable.</strong><span>Installed {terminology.singular} management still works. Add an API key in Settings to search and install {terminology.plural}.</span></section>}
      <ModsSummary mods={data.installedMods} updatePlan={data.updatePlan} loading={state.modsLoading} terminology={terminology} />
      <div className="modsWorkspaceToolbar">
        <div className="modsWorkspacePrimaryActions"><Button onClick={actions.openAdd} disabled={access.addDisabled} title={access.addDisabledReason}><AppIcon name="plus" /> Add {terminology.plural}</Button><Button variant="secondary" onClick={() => uploadRef.current?.click()} disabled={access.uploadDisabled} title={access.uploadDisabledReason}><AppIcon name="fileUp" /> Upload jar</Button></div>
        <div className="modsWorkspaceUpdateActions">
          <span className="modsWorkspaceLastChecked">Last checked: {data.updatePlan ? <time dateTime={data.updatePlan.generatedAt} title={relativeTimestamps ? formatters.date(data.updatePlan.generatedAt) : undefined}>{relativeTimestamps ? formatRelativeTimestamp(data.updatePlan.generatedAt) : formatters.date(data.updatePlan.generatedAt)}</time> : "Never"}</span>
          <Button variant="secondary" onClick={() => { if (!updateCheckWaitingForMods) void actions.refresh(); }} disabled={updateCheckWaitingForMods || state.updatePlanLoading} title={updateCheckWaitingForMods ? `Waiting for the current ${terminology.singular} change to finish.` : state.updatePlanLoading ? `Checking installed ${terminology.plural} for updates.` : `Check installed ${terminology.plural} for updates.`} reserveLabel={<><AppIcon name="refresh" />Check updates</>}><AppIcon name="refresh" /> {state.updatePlanLoading ? "Checking…" : "Check updates"}</Button>
          {showSafeBatch && <Button className="modsWorkspaceBatchAction" onClick={() => void actions.updateAllSafe()} disabled={!canRunSafeBatch} reserveLabel={`Updating safe ${terminology.plural}…`}>{state.batchUpdateRunning ? `Updating safe ${terminology.plural}…` : `Update all safe (${data.updatePlan?.counts.safeUpdates})`}</Button>}
        </div>
      </div>
      <input ref={uploadRef} className="hiddenInput" type="file" accept=".jar" multiple onChange={actions.uploadMod} />
      {visibleModsError && <InlineState tone="error" title={`Could not load installed ${terminology.plural}`} message={visibleModsError} actionLabel="Retry" onAction={actions.retry} busy={state.modsLoading} />}
      {visibleUpdatePlanError && <InlineState tone="error" title="Could not check updates" message={visibleUpdatePlanError} actionLabel="Retry" onAction={() => void actions.refresh()} busy={state.updatePlanLoading} />}
      <InstalledModsList terminology={terminology} mods={data.installedMods} restartRequiredChanges={restartRequiredChanges} query={state.installedQuery} busy={state.modsLoading} locked={access.toggleLocked} switchLocked={access.locked} dependencyInstallLocked={access.addDisabled} onQueryChange={actions.setInstalledQuery} onToggle={actions.setInstalledModEnabled} onUpdate={actions.updateMod} onInstallDependencies={actions.installMissingDependencies} onSwitchVersion={actions.openSwitchVersionReview} onDetails={actions.setDetailsMod} onDropFiles={actions.uploadModFiles} dropLocked={access.uploadDisabled} updatePlan={data.updatePlan} />
      {(state.addOpen || state.detailsMod) && <div className="modsDrawerBackdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) state.addOpen ? actions.closeAdd() : actions.setDetailsMod(null); }}>
        {state.addOpen && <DialogSurface className="modsWorkflowDrawer" labelledBy="add-mods-title" onClose={actions.closeAdd}><span id="add-mods-title" className="visuallyHidden">Add {terminology.plural}</span><AddModsWorkflow terminology={terminology} query={state.query} results={data.searchResults} total={data.searchTotal} installedMods={data.installedMods} searching={state.searching} loadingMore={state.loadingMore} error={state.searchError} configured={access.modrinthConfigured} versionsUnknown={serverContext.versionsUnknown} contextMessage={serverContext.contextMessage} minecraftVersion={serverContext.minecraftVersion} showIncompatibleResults={state.showIncompatibleResults} locked={access.locked} sentinelRef={refs.sentinelRef} installState={state.installState} selectedVersion={derived.selectedVersion} requiredDependencies={derived.pendingDependencies} canContinue={derived.canContinueInstall} formatDate={formatters.date} formatNumber={formatters.number} onClose={actions.closeAdd} onQueryChange={actions.setQuery} onShowIncompatibleResultsChange={actions.setShowIncompatibleResults} onChoose={actions.openInstallReview} onRetrySearch={actions.retrySearch} onInstallClose={actions.closeInstall} onChannelChange={(mod, channel) => void actions.loadInstallVersions(mod, channel)} onSelectVersion={actions.selectInstallVersion} onToggleAdvanced={actions.toggleAdvanced} onAcknowledge={actions.acknowledgeInstall} onContinue={actions.continueInstallReview} onBack={actions.backInstall} onInstall={actions.installSelectedMod} /></DialogSurface>}
        {state.detailsMod && <ModDetailsPanel terminology={terminology} mod={state.detailsMod} locked={access.locked} reviewAcknowledgementLocked={access.reviewAcknowledgementLocked} dependencyInstallLocked={access.addDisabled} formatDate={formatters.date} onClose={() => actions.setDetailsMod(null)} onToggle={actions.setInstalledModEnabled} onUpdate={actions.updateMod} onInstallDependencies={actions.installMissingDependencies} onRemove={actions.removeMod} onAcknowledgeReview={actions.acknowledgeModReview} updatePlanEntry={updatePlanEntryForMod(data.updatePlan, state.detailsMod)} />}
      </div>}
    </section>
  );
}
