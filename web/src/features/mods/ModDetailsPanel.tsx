import { useEffect, useState } from "react";
import type { InstalledMod, ModUpdatePlanEntry } from "../../types";
import { AppIcon } from "../../components/FileTypeIcon";
import { Button } from "../../components/UiPrimitives";
import { formatBytes } from "../../utils/format";
import { modIconSource } from "../../utils/appHelpers";
import { getInstalledModHealth, modVersion } from "./modHealth";
import { applyUpdatePlanEntry } from "./modUpdatePlan";
import { ModIconImage } from "./ModIconImage";
import { DialogSurface } from "../../components/DialogSurface";
import { fabricContentTerminology, type ManagedContentTerminology } from "./contentTerminology";

function technicalValue(value?: string) {
  if (!value) return "Unknown";
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function technicalTone(value?: string) {
  return `tone-${(value || "unknown").toLowerCase().replaceAll("_", "-")}`;
}

type Props = {
  terminology?: ManagedContentTerminology;
  mod: InstalledMod;
  locked: boolean;
  reviewAcknowledgementLocked: boolean;
  dependencyInstallLocked?: boolean;
  formatDate: (value: string | number | Date) => string;
  onClose: () => void;
  onToggle: (mod: InstalledMod, enabled: boolean) => void;
  onUpdate: (mod: InstalledMod) => void;
  onInstallDependencies?: (mod: InstalledMod) => void;
  onRemove: (mod: InstalledMod) => void;
  onAcknowledgeReview: (mod: InstalledMod) => Promise<void> | void;
  updatePlanEntry?: ModUpdatePlanEntry | null;
};

export function ModDetailsPanel({ terminology = fabricContentTerminology, mod, locked, reviewAcknowledgementLocked, dependencyInstallLocked = locked, formatDate, onClose, onToggle, onUpdate, onInstallDependencies, onRemove, onAcknowledgeReview, updatePlanEntry }: Props) {
  const health = getInstalledModHealth(applyUpdatePlanEntry(mod, updatePlanEntry ?? null), terminology);
  const icon = modIconSource(mod.iconUrl);
  const [reviewingUpdate, setReviewingUpdate] = useState(false);
  const [updateAcknowledged, setUpdateAcknowledged] = useState(false);
  const [reviewingInstalledVersion, setReviewingInstalledVersion] = useState(false);
  const [installedReviewAcknowledged, setInstalledReviewAcknowledged] = useState(false);
  const [acknowledgingInstalledReview, setAcknowledgingInstalledReview] = useState(false);
  const canAcknowledgeInstalledReview = Boolean(mod.modrinth && health.key === "needs_review");
  const hasPlannedUpdate = Boolean(updatePlanEntry && ["safe_update", "needs_review", "blocked"].includes(updatePlanEntry.status));
  const statusTone = updatePlanEntry?.status === "safe_update" ? "ready" : updatePlanEntry?.status === "blocked" ? "not-recommended" : updatePlanEntry?.status === "needs_review" ? "review" : health.tone;
  const statusTitle = updatePlanEntry?.status === "safe_update"
    ? `Safe to update${updatePlanEntry.targetVersion ? ` to ${updatePlanEntry.targetVersion}` : ""}`
    : updatePlanEntry?.status === "needs_review"
      ? `Review update${updatePlanEntry.targetVersion ? ` to ${updatePlanEntry.targetVersion}` : ""}`
      : updatePlanEntry?.status === "blocked"
        ? "Update blocked"
        : health.label;
  const statusDescription = hasPlannedUpdate ? updatePlanEntry?.reason : health.shortDescription;
  const reasonTone = health.tone === "ready"
    ? "ready"
    : health.tone === "not-recommended"
      ? "not-recommended"
      : health.tone === "review" || health.tone === "update"
        ? "review"
        : "unknown";

  useEffect(() => {
    setReviewingUpdate(false);
    setUpdateAcknowledged(false);
    setReviewingInstalledVersion(false);
    setInstalledReviewAcknowledged(false);
    setAcknowledgingInstalledReview(false);
  }, [mod.filename, mod.modrinth?.versionId]);

  async function confirmInstalledReviewAcknowledgement() {
    if (!installedReviewAcknowledged || acknowledgingInstalledReview || reviewAcknowledgementLocked) return;
    setAcknowledgingInstalledReview(true);
    try {
      await onAcknowledgeReview(mod);
      setReviewingInstalledVersion(false);
      setInstalledReviewAcknowledged(false);
    } finally {
      setAcknowledgingInstalledReview(false);
    }
  }

  return (
    <DialogSurface className="modsDetailsDrawer" labelledBy="mod-details-title" onClose={onClose}>
      <div className="modsDrawerHeader">
        <div className="modsDetailsTitle">
          <ModIconImage src={icon} fallback="JAR" />
          <div><h2 id="mod-details-title">{mod.displayName}</h2><span>{mod.enabled ? "Enabled" : "Disabled"}</span></div>
        </div>
        <Button variant="secondary" iconOnly className="iconButton" onClick={onClose} aria-label={`Close ${terminology.singular} details`}><AppIcon name="x" /></Button>
      </div>
      <div className="modsDrawerBody">
        {mod.description && <p className="modsDetailsDescription">{mod.description}</p>}
        <section className={`modsHealthReasonBanner ${reasonTone}`} aria-label="Compatibility reason">
          <strong>{health.label}</strong>
          <span>{health.detailDescription}</span>
        </section>
        {mod.dependencyHealth?.status === "missing" && (
          <section className="modsReviewSection" aria-labelledby="missing-dependencies-title">
            <h3 id="missing-dependencies-title">Required dependencies</h3>
            {mod.dependencyHealth.missing.map((dependency, index) => (
              <div className="modsReviewLine" key={`${dependency.projectId || dependency.versionId || "dependency"}-${index}`}>
                <strong>{dependency.title || dependency.projectId || "Required dependency"}</strong>
                <span>{dependency.disabled ? "Disabled" : "Not installed"}</span>
              </div>
            ))}
          </section>
        )}
        <dl className="modsDetailsFacts">
          <div><dt>Installed version</dt><dd>{modVersion(mod)}</dd></div>
          {hasPlannedUpdate && updatePlanEntry?.targetVersion && <div><dt>Available version</dt><dd>{updatePlanEntry.targetVersion}</dd></div>}
        </dl>
        <section className={`modsCompatibilityCard ${statusTone}`}>
          <strong>{statusTitle}</strong>
          <p>{statusDescription}</p>
          <details>
            <summary>Technical compatibility details</summary>
            <dl className="modsCompatibilityFacts">
              <div className="modsCompatibilityReason"><dt>Health reason</dt><dd>{health.detailDescription}</dd></div>
              {mod.compatibility && (
                <>
                <div><dt>Raw status</dt><dd><span className={technicalTone(mod.compatibility.status)}>{technicalValue(mod.compatibility.status)}</span></dd></div>
                <div><dt>Server side</dt><dd><span className={technicalTone(mod.compatibility.serverSide)}>{technicalValue(mod.compatibility.serverSide)}</span></dd></div>
                <div><dt>Client side</dt><dd><span className={technicalTone(mod.compatibility.clientSide)}>{technicalValue(mod.compatibility.clientSide)}</span></dd></div>
                {mod.compatibility.matchedGameVersions?.length && <div><dt>Game versions</dt><dd>{mod.compatibility.matchedGameVersions.map((version) => <span key={version}>{version}</span>)}</dd></div>}
                {mod.compatibility.matchedLoaders?.length && <div><dt>Loaders</dt><dd>{mod.compatibility.matchedLoaders.map((loader) => <span key={loader}>{technicalValue(loader)}</span>)}</dd></div>}
                </>
              )}
            </dl>
          </details>
        </section>
        {reviewingUpdate && updatePlanEntry?.status === "needs_review" && (
          <section className="modsUpdateReview" aria-labelledby="review-update-title">
            <strong id="review-update-title">Review update{updatePlanEntry.targetVersion ? ` to ${updatePlanEntry.targetVersion}` : ""}</strong>
            <p>{updatePlanEntry.reason}</p>
            <label className="modsRiskAcknowledgement">
              <input type="checkbox" checked={updateAcknowledged} onChange={(event) => setUpdateAcknowledged(event.target.checked)} />
              <span><strong>Compatibility is not fully verified.</strong>I understand this update may not be safe for this server.</span>
            </label>
            <div className="modsUpdateReviewActions">
              <Button variant="secondary" onClick={() => { setReviewingUpdate(false); setUpdateAcknowledged(false); }}>Cancel</Button>
              <Button onClick={() => onUpdate(mod)} disabled={locked || !updateAcknowledged}>Confirm update</Button>
            </div>
          </section>
        )}
        {reviewingInstalledVersion && canAcknowledgeInstalledReview && (
          <section className="modsUpdateReview" aria-labelledby="review-installed-title">
            <strong id="review-installed-title">Acknowledge review</strong>
            <p>{health.detailDescription}</p>
            <label className="modsRiskAcknowledgement">
              <input type="checkbox" checked={installedReviewAcknowledged} onChange={(event) => setInstalledReviewAcknowledged(event.target.checked)} disabled={reviewAcknowledgementLocked || acknowledgingInstalledReview} />
              <span><strong>Compatibility is not fully verified.</strong> I reviewed this installed version and want to mark it healthy until the version changes.</span>
            </label>
            <div className="modsUpdateReviewActions">
              <Button variant="secondary" onClick={() => { setReviewingInstalledVersion(false); setInstalledReviewAcknowledged(false); }} disabled={acknowledgingInstalledReview}>Cancel</Button>
              <Button onClick={() => void confirmInstalledReviewAcknowledgement()} disabled={reviewAcknowledgementLocked || acknowledgingInstalledReview || !installedReviewAcknowledged}>{acknowledgingInstalledReview ? "Acknowledging..." : "Mark healthy"}</Button>
            </div>
          </section>
        )}
        <details className="modsTechnicalDetails">
            <summary>File and source details</summary>
            <dl className="modsDetailsFacts">
              <div><dt>Source</dt><dd>{mod.modrinth ? "Modrinth" : "Manual upload"}</dd></div>
              <div><dt>Filename</dt><dd>{mod.filename}</dd></div>
              <div><dt>File size</dt><dd>{formatBytes(mod.size)}</dd></div>
              <div><dt>Modified</dt><dd>{formatDate(mod.modifiedAt)}</dd></div>
              {hasPlannedUpdate && updatePlanEntry?.targetFilename && <div><dt>Available filename</dt><dd>{updatePlanEntry.targetFilename}</dd></div>}
              {mod.modrinth && <><div><dt>Project ID</dt><dd>{mod.modrinth.projectId}</dd></div><div><dt>Version ID</dt><dd>{mod.modrinth.versionId}</dd></div><div><dt>Installed</dt><dd>{formatDate(mod.modrinth.installedAt)}</dd></div><div><dt>Game versions</dt><dd>{mod.modrinth.gameVersions.join(", ") || "Unknown"}</dd></div><div><dt>Loaders</dt><dd>{mod.modrinth.loaders.join(", ") || "Unknown"}</dd></div></>}
            </dl>
            {mod.modrinth && <a href={`https://modrinth.com/${terminology.modrinthProjectType}/${mod.modrinth.projectId}`} target="_blank" rel="noreferrer">View on Modrinth</a>}
          </details>
      </div>
      <div className="modsDrawerFooter">
        {health.key === "missing_dependencies" && <Button onClick={() => onInstallDependencies?.(mod)} disabled={dependencyInstallLocked}>Install dependencies</Button>}
        {updatePlanEntry?.status === "safe_update" && <Button onClick={() => onUpdate(mod)} disabled={locked}>Update{updatePlanEntry.targetVersion ? ` to ${updatePlanEntry.targetVersion}` : ""}</Button>}
        {updatePlanEntry?.status === "needs_review" && !reviewingUpdate && <Button onClick={() => setReviewingUpdate(true)} disabled={locked}>Review update</Button>}
        {canAcknowledgeInstalledReview && !reviewingInstalledVersion && <Button onClick={() => setReviewingInstalledVersion(true)} disabled={reviewAcknowledgementLocked}>Acknowledge review</Button>}
        <Button variant="secondary" onClick={() => onToggle(mod, !mod.enabled)} disabled={locked}>{mod.enabled ? "Disable" : "Enable"}</Button>
        <Button variant="critical" onClick={() => onRemove(mod)} disabled={locked}>Remove</Button>
      </div>
    </DialogSurface>
  );
}
