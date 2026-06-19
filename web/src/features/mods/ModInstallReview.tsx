import type { ModInstallModalState } from "../../app/uiState";
import type { ModrinthInstallVersion, ReleaseChannel } from "../../types";
import { AppIcon } from "../../components/FileTypeIcon";
import { InlineState } from "../../components/InlineState";
import { ModInstallVersionSkeleton } from "../../components/ModInstallVersionSkeleton";
import { modIconSource } from "../../utils/appHelpers";
import { getInstallVersionHealth } from "./modHealth";

type Props = {
  state: ModInstallModalState;
  selected: ModrinthInstallVersion | null;
  requiredDependencies: ModrinthInstallVersion["dependencies"];
  canContinue: boolean;
  formatDate: (value: string | number | Date) => string;
  onClose: () => void;
  onChannelChange: (channel: ReleaseChannel) => void;
  onSelect: (version: ModrinthInstallVersion) => void;
  onToggleAdvanced: () => void;
  onAcknowledge: (checked: boolean) => void;
  onContinue: () => void;
  onBack: () => void;
  onInstall: () => void;
};

export function ModInstallReview({ state, selected, requiredDependencies, canContinue, formatDate, onClose, onChannelChange, onSelect, onToggleAdvanced, onAcknowledge, onContinue, onBack, onInstall }: Props) {
  const title = state.data?.project.title || state.mod.title;
  const versions = state.data?.compatibleVersions || [];
  const otherVersions = state.data?.otherVersions || [];
  const icon = modIconSource(state.data?.project.iconUrl || state.mod.icon_url);
  const selectedHealth = selected ? getInstallVersionHealth(selected) : null;
  const recommendedVersion = versions.find((version) => getInstallVersionHealth(version).safeToRunDirectly);

  return (
    <div className="modsInstallReview">
      <div className="modsDrawerHeader">
        <div><button type="button" className="modsBackButton" onClick={state.step === 2 ? onBack : onClose}><AppIcon name="chevronLeft" /> {state.step === 2 ? "Back" : "Search"}</button><h2>{state.step === 2 ? "Review installation" : "Choose a version"}</h2></div>
        <button type="button" className="iconButton" onClick={onClose} disabled={state.installing} aria-label="Close install review"><AppIcon name="x" /></button>
      </div>
      <div className="modsDrawerBody">
        <div className="modsReviewHero">
          {icon ? <img src={icon} alt="" /> : <span className="modsWorkspaceFallback">MOD</span>}
          <div><strong>{title}</strong><span>For {state.data?.target.loader || "Fabric"} {state.data?.target.minecraftVersion || ""}</span></div>
        </div>
        {state.loading && <ModInstallVersionSkeleton />}
        {!state.loading && state.error && <InlineState tone="error" title="Versions unavailable" message={state.error} />}
        {!state.loading && state.data && state.step === 1 && (
          <>
            <section className="modsRecommendedVersion">
              <div><small>Recommended for this server</small><strong>{recommendedVersion?.versionNumber || "No verified release found"}</strong><span>{recommendedVersion ? "Compatible with this server" : "Open advanced options to review other versions"}</span></div>
              {recommendedVersion && <button type="button" onClick={() => { onSelect(recommendedVersion); onContinue(); }}>Review and install</button>}
            </section>
            <details className="modsAdvancedOptions" open={state.showOtherVersions} onToggle={(event) => { if ((event.currentTarget as HTMLDetailsElement).open !== state.showOtherVersions) onToggleAdvanced(); }}>
              <summary>Advanced options</summary>
              <p>Choose a channel or select a version manually. Versions outside the recommended path may require acknowledgement.</p>
              <div className="modsChannelPicker" role="group" aria-label="Release channel">
                {(["release", "beta", "alpha"] as ReleaseChannel[]).map((channel) => <button key={channel} type="button" className={state.channel === channel ? "active" : ""} onClick={() => onChannelChange(channel)}>{channel}</button>)}
              </div>
              <div className="modsVersionList">
                {[...versions, ...otherVersions].map((version) => {
                  const health = getInstallVersionHealth(version);
                  return (
                    <button key={version.id} type="button" className={state.selectedVersionId === version.id ? "selected" : ""} onClick={() => onSelect(version)} disabled={!version.selectable}>
                      <span><strong>{version.versionNumber}</strong><small>{version.minecraftVersions.join(", ")}</small></span><span className={`modsStatusChip ${health.tone}`}>{health.label}</span>
                    </button>
                  );
                })}
              </div>
              {selected && <button type="button" onClick={onContinue} disabled={!canContinue}>Review selected version</button>}
            </details>
            {selectedHealth?.requiresAcknowledgement && (
              <label className="modsRiskAcknowledgement"><input type="checkbox" checked={state.acknowledgeMinecraftMismatch} onChange={(event) => onAcknowledge(event.target.checked)} /><span><strong>{selectedHealth.label}.</strong>I understand ServerSentinel cannot verify this version as safe for this server.</span></label>
            )}
          </>
        )}
        {!state.loading && state.data && state.step === 2 && selected && (
          <>
            <section className="modsReviewSection"><h3>What will be installed</h3><div className="modsReviewLine"><strong>{title}</strong><span>{selected.versionNumber}</span></div></section>
            <section className="modsReviewSection"><h3>Server target</h3><div className="modsReviewLine"><strong>{state.data.target.serverName}</strong><span>Fabric · Minecraft {state.data.target.minecraftVersion}</span></div></section>
            {requiredDependencies.length > 0 && <details className="modsDependencySummary" open><summary>Also installs {requiredDependencies.length} required {requiredDependencies.length === 1 ? "dependency" : "dependencies"}</summary>{requiredDependencies.map((dependency, index) => <div key={`${dependency.projectId}-${index}`}>{dependency.title || dependency.projectId || "Required dependency"}</div>)}</details>}
            {selectedHealth?.requiresAcknowledgement && <div className="modsReviewWarning"><strong>{selectedHealth.label}</strong><span>{selectedHealth.detailDescription}</span></div>}
            <details className="modsAdvancedOptions"><summary>Installation details</summary><dl className="modsDetailsFacts"><div><dt>Release channel</dt><dd>{selected.releaseChannel}</dd></div><div><dt>Published</dt><dd>{selected.publishedAt ? formatDate(selected.publishedAt) : "Unknown"}</dd></div><div><dt>Filename</dt><dd>{selected.file?.filename || "Unknown"}</dd></div></dl></details>
          </>
        )}
      </div>
      {state.step === 2 && <div className="modsDrawerFooter"><button type="button" onClick={onInstall} disabled={!canContinue || state.installing}>{state.installing ? "Installing…" : requiredDependencies.length > 0 ? "Install mod and dependencies" : "Install mod"}</button></div>}
    </div>
  );
}
