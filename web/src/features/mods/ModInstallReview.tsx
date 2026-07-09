import type { ModInstallModalState } from "../../app/uiState";
import type { ModrinthInstallVersion, ReleaseChannel } from "../../types";
import { AppIcon } from "../../components/FileTypeIcon";
import { InlineState } from "../../components/InlineState";
import { Button } from "../../components/UiPrimitives";
import { ModInstallVersionSkeleton } from "../../components/ModInstallVersionSkeleton";
import { modIconSource } from "../../utils/appHelpers";
import { getInstallVersionHealth } from "./modHealth";
import { ModIconImage } from "./ModIconImage";
import { ModStatusBadge } from "./ModStatusBadge";

type Props = {
  state: ModInstallModalState;
  selected: ModrinthInstallVersion | null;
  requiredDependencies: ModrinthInstallVersion["dependencies"];
  canContinue: boolean;
  locked?: boolean;
  lockedReason?: string;
  formatDate: (value: string | number | Date) => string;
  onClose: () => void;
  onChannelChange: (channel: ReleaseChannel) => void;
  onRetry: () => void;
  onSelect: (version: ModrinthInstallVersion) => void;
  onToggleAdvanced: () => void;
  onAcknowledge: (checked: boolean) => void;
  onContinue: () => void;
  onBack: () => void;
  onInstall: () => void;
};

export function ModInstallReview({ state, selected, requiredDependencies, canContinue, locked = false, lockedReason = "", formatDate, onClose, onChannelChange, onRetry, onSelect, onToggleAdvanced, onAcknowledge, onContinue, onBack, onInstall }: Props) {
  const switchMode = state.mode === "switch";
  const title = state.data?.project.title || state.mod.title;
  const versions = state.data?.compatibleVersions || [];
  const otherVersions = state.data?.otherVersions || [];
  const icon = modIconSource(state.data?.project.iconUrl || state.mod.icon_url);
  const selectedHealth = selected ? getInstallVersionHealth(selected) : null;
  const recommendedVersion = versions.find((version) => getInstallVersionHealth(version).safeToRunDirectly);
  const selectedIncompatible = Boolean(selected && !selected.compatible);
  const selectedRiskDetail = selected && selectedIncompatible
    ? `${selected.reason} This version is not marked compatible with the server Minecraft version (${state.data?.target.minecraftVersion || "unknown"}).`
    : selectedHealth?.detailDescription;
  const installButtonLabel = switchMode
    ? "Switch version"
    : selectedHealth?.requiresAcknowledgement
    ? selectedIncompatible ? "Install incompatible mod" : "Install anyway"
    : requiredDependencies.length > 0 ? "Install mod and dependencies" : "Install mod";
  const installingLabel = switchMode ? "Switching..." : "Installing...";

  return (
    <div className="modsInstallReview">
      <div className="modsDrawerHeader">
        <div><Button variant="ghost" compact className="modsBackButton" onClick={state.step === 2 ? onBack : onClose}><AppIcon name="chevronLeft" /> {state.step === 2 ? "Back" : switchMode ? "Installed mods" : "Search"}</Button><h2>{state.step === 2 ? switchMode ? "Review switch" : "Review installation" : "Choose a version"}</h2></div>
        <Button variant="secondary" iconOnly className="iconButton" onClick={onClose} disabled={state.installing} aria-label="Close install review"><AppIcon name="x" /></Button>
      </div>
      <div className="modsDrawerBody">
        <div className="modsReviewHero">
          <ModIconImage src={icon} fallback="MOD" />
          <div><strong>{title}</strong><span>For {state.data?.target.loader || "Fabric"} {state.data?.target.minecraftVersion || ""}</span></div>
        </div>
        {locked && <InlineState tone="info" title="Stop the server to install mods" message={lockedReason || "Mod changes require the server to be stopped."} />}
        {state.loading && <ModInstallVersionSkeleton />}
        {!state.loading && state.error && <InlineState tone="error" title="Versions unavailable" message={state.error} actionLabel="Refresh" onAction={onRetry} busy={state.loading} />}
        {!state.loading && state.data && state.step === 1 && (
          <>
            <section className="modsRecommendedVersion">
              <div><small>Recommended for this server</small><strong>{recommendedVersion?.versionNumber || "No verified release found"}</strong><span>{recommendedVersion ? "Compatible with this server" : "Open advanced options to review other versions"}</span></div>
              {recommendedVersion && <Button onClick={() => { onSelect(recommendedVersion); onContinue(); }} disabled={locked}>{switchMode ? "Review switch" : "Review and install"}</Button>}
            </section>
            <details className="modsAdvancedOptions" open={state.showOtherVersions} onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open !== state.showOtherVersions) onToggleAdvanced(); }}>
              <summary>Advanced options</summary>
              <p>Choose a channel or select a version manually. Versions outside the recommended path may require acknowledgement.</p>
              <div className="modsChannelPicker" role="group" aria-label="Release channel">
                {(["release", "beta", "alpha"] as ReleaseChannel[]).map((channel) => <Button key={channel} variant="ghost" compact className={state.channel === channel ? "active" : ""} onClick={() => onChannelChange(channel)} disabled={locked}>{channel}</Button>)}
              </div>
              <div className="modsVersionList">
                {[...versions, ...otherVersions].map((version) => {
                  const health = getInstallVersionHealth(version);
                  return (
                    <button key={version.id} type="button" className={state.selectedVersionId === version.id ? "selected" : ""} onClick={() => onSelect(version)} disabled={locked || !version.selectable}>
                      <span><strong>{version.versionNumber}</strong><small>{version.minecraftVersions.join(", ")}</small></span><ModStatusBadge tone={health.tone}>{health.label}</ModStatusBadge>
                    </button>
                  );
                })}
              </div>
              {selected && <Button onClick={onContinue} disabled={locked || !canContinue}>Review selected version</Button>}
            </details>
            {selectedHealth?.requiresAcknowledgement && (
              <label className="modsRiskAcknowledgement"><input type="checkbox" checked={state.acknowledgeMinecraftMismatch} onChange={(event) => onAcknowledge(event.target.checked)} disabled={locked} /><span><strong>{selectedHealth.label}.</strong>{selectedIncompatible ? ` This version is not marked compatible with the server Minecraft version (${state.data.target.minecraftVersion}).` : " serverSENTINEL cannot verify this version as safe for this server."} I understand the risk.</span></label>
            )}
          </>
        )}
        {!state.loading && state.data && state.step === 2 && selected && (
          <>
            <section className="modsReviewSection"><h3>{switchMode ? "What will change" : "What will be installed"}</h3><div className="modsReviewLine"><strong>{title}</strong><span>{selected.versionNumber}</span></div></section>
            <section className="modsReviewSection"><h3>Server target</h3><div className="modsReviewLine"><strong>{state.data.target.serverName}</strong><span>Fabric - Minecraft {state.data.target.minecraftVersion}</span></div></section>
            {!switchMode && requiredDependencies.length > 0 && <details className="modsDependencySummary" open><summary>Also installs {requiredDependencies.length} required {requiredDependencies.length === 1 ? "dependency" : "dependencies"}</summary>{requiredDependencies.map((dependency, index) => <div key={`${dependency.projectId}-${index}`}>{dependency.title || dependency.projectId || "Required dependency"}</div>)}</details>}
            {selectedHealth?.requiresAcknowledgement && <div className="modsReviewWarning"><strong>{selectedHealth.label}</strong><span>{selectedRiskDetail}</span></div>}
            <details className="modsAdvancedOptions"><summary>Installation details</summary><dl className="modsDetailsFacts"><div><dt>Release channel</dt><dd>{selected.releaseChannel}</dd></div><div><dt>Published</dt><dd>{selected.publishedAt ? formatDate(selected.publishedAt) : "Unknown"}</dd></div><div><dt>Filename</dt><dd>{selected.file?.filename || "Unknown"}</dd></div></dl></details>
          </>
        )}
      </div>
      {state.step === 2 && (
        <div className="modsDrawerFooter">
          <Button onClick={onInstall} disabled={locked || !canContinue || state.installing} reserveLabel={installButtonLabel.length > installingLabel.length ? installButtonLabel : installingLabel}>{state.installing ? installingLabel : installButtonLabel}</Button>
        </div>
      )}
    </div>
  );
}
