import { useState, type DragEvent, type ReactNode } from "react";
import type { InstalledMod, ModUpdatePlan, RestartRequiredChange } from "../../types";
import { AppIcon } from "../../components/FileTypeIcon";
import { Button, EmptyState, LoadingLabel, SkeletonBlock } from "../../components/UiPrimitives";
import { modIconSource } from "../../utils/appHelpers";
import { getInstalledModHealth, modVersion } from "./modHealth";
import { applyUpdatePlanEntry, updatePlanEntryForMod } from "./modUpdatePlan";
import { ModIconImage } from "./ModIconImage";
import { filterInstalledMods } from "./modsWorkspaceHelpers";
import { ModStatusBadge } from "./ModStatusBadge";

type Props = {
  mods: InstalledMod[];
  restartRequiredChanges?: RestartRequiredChange[];
  query: string;
  busy: boolean;
  locked: boolean;
  switchLocked?: boolean;
  dependencyInstallLocked?: boolean;
  onQueryChange: (value: string) => void;
  onToggle: (mod: InstalledMod, enabled: boolean) => void;
  onUpdate: (mod: InstalledMod) => void;
  onInstallDependencies?: (mod: InstalledMod) => void;
  onSwitchVersion: (mod: InstalledMod) => void;
  onDetails: (mod: InstalledMod) => void;
  onDropFiles?: (files: File[]) => void;
  dropLocked?: boolean;
  updatePlan?: ModUpdatePlan | null;
};

export function InstalledModsList({ mods, restartRequiredChanges = [], query, busy, locked, switchLocked = locked, dependencyInstallLocked = locked, onQueryChange, onToggle, onUpdate, onInstallDependencies, onSwitchVersion, onDetails, onDropFiles, dropLocked = false, updatePlan }: Props) {
  const visible = filterInstalledMods(mods, query);
  const initialLoading = busy && mods.length === 0;
  const [draggingFiles, setDraggingFiles] = useState(false);

  function hasFiles(event: DragEvent) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  return (
    <section className="modsWorkspaceInstalled" aria-labelledby="installed-mods-title">
      <div className="modsWorkspaceListHeader">
        <div>
          <h3 id="installed-mods-title">Installed mods</h3>
          <span>{initialLoading ? <SkeletonBlock className="modsTotalSkeleton" /> : `${mods.length} total`}</span>
        </div>
        <label className="modsWorkspaceSearch">
          <AppIcon name="search" />
          <span className="srOnly">Search</span>
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search" disabled={initialLoading} />
        </label>
      </div>

      <div
        className={`modsWorkspaceTable ${draggingFiles ? "isDragTarget" : ""}`}
        aria-busy={busy}
        onDragEnter={(event) => { if (hasFiles(event) && !dropLocked) { event.preventDefault(); setDraggingFiles(true); } }}
        onDragOver={(event) => { if (hasFiles(event) && !dropLocked) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } }}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDraggingFiles(false); }}
        onDrop={(event) => {
          event.preventDefault();
          setDraggingFiles(false);
          if (!dropLocked) onDropFiles?.(Array.from(event.dataTransfer.files));
        }}
      >
        {draggingFiles && <div className="modsWorkspaceDropOverlay" role="status"><AppIcon name="fileUp" /><strong>Drop JAR files to upload</strong></div>}
        <div className="modsWorkspaceTableHead" aria-hidden="true">
          <span>Mod</span><span>Status</span><span>Installed version</span><span>Update</span><span>Enabled</span><span />
        </div>
        {initialLoading && <LoadingLabel>Loading installed mods</LoadingLabel>}
        {initialLoading ? (
          Array.from({ length: 5 }, (_, index) => <InstalledModSkeletonRow key={index} />)
        ) : visible.length === 0 ? (
          <EmptyState compact className="modsWorkspaceEmpty" title={mods.length ? "No matching mods" : "No mods installed yet"} message={mods.length ? "Try a different search." : "Add a compatible Fabric mod or upload a jar to get started."} />
        ) : visible.map((mod) => {
          const plannedUpdate = updatePlanEntryForMod(updatePlan ?? null, mod);
          const health = getInstalledModHealth(applyUpdatePlanEntry(mod, plannedUpdate));
          const targetVersion = plannedUpdate?.targetVersion || mod.versionInfo?.latestVersion;
          const icon = modIconSource(mod.iconUrl);
          const identity = mod.modrinth?.projectId ? `modrinth:${mod.modrinth.projectId}` : `file:${mod.filename.replace(/\.jar\.disabled$/i, ".jar").toLowerCase()}`;
          const requiresRestart = restartRequiredChanges.some((change) => change.identity === identity && change.action !== "removed");
          return (
            <article
              key={mod.filename}
              className={`modsWorkspaceRow ${mod.enabled ? "" : "isDisabled"}`}
            >
              <button type="button" className="modsWorkspaceIdentity" onClick={() => onDetails(mod)} aria-label={`Open details for ${mod.displayName}`}>
                <ModIconImage src={icon} fallback="JAR" />
                <span><strong>{mod.displayName}</strong>{mod.description && <small>{mod.description}</small>}</span>
                <AppIcon name="chevronRight" />
              </button>
              <div className="modsWorkspaceStatus"><ModStatusBadge tone={health.tone}>{health.label}</ModStatusBadge>{requiresRestart && <ModStatusBadge tone="update">Requires restart</ModStatusBadge>}</div>
              <div className="modsWorkspaceVersion">{modVersion(mod)}</div>
              <div className="modsWorkspaceUpdate">
                {health.key === "missing_dependencies" && (
                  <Button variant="secondary" compact className="modsReviewAction" onClick={() => onInstallDependencies?.(mod)} disabled={dependencyInstallLocked} title={health.detailDescription}>
                    Install dependencies
                  </Button>
                )}
                {plannedUpdate?.status === "safe_update" && (
                  <Button variant="secondary" compact className="modsUpdateAction" onClick={() => onUpdate(mod)} disabled={locked} aria-label={`Update ${mod.displayName}${targetVersion ? ` to ${targetVersion}` : ""}`} title={`Download and install${targetVersion ? ` ${targetVersion}` : " the available update"}`}>
                    <span className="modsUpdateTransition" aria-hidden="true">
                      <span className="modsUpdateArrow">→</span>
                      <strong>{targetVersion || "Available"}</strong>
                    </span>
                    <span className="modsUpdateActionLabel">Update</span>
                  </Button>
                )}
                {plannedUpdate?.status === "needs_review" && (
                  <ModUpdateCell targetVersion={targetVersion} actionTone="review">
                    <Button variant="secondary" compact className="modsReviewAction" onClick={() => onDetails(mod)} disabled={locked} title={health.shortDescription}>
                      {health.primaryActionLabel}
                    </Button>
                  </ModUpdateCell>
                )}
              </div>
              <div className="modsWorkspaceEnabled">
                <label className="switch modsWorkspaceSwitch">
                  <input type="checkbox" checked={mod.enabled} onChange={() => onToggle(mod, !mod.enabled)} disabled={locked} aria-label={`${mod.enabled ? "Disable" : "Enable"} ${mod.displayName}`} />
                  <span className="slider" />
                </label>
              </div>
              <Button variant="ghost" iconOnly className="modsWorkspaceSwitchVersionButton" onClick={() => onSwitchVersion(mod)} disabled={switchLocked || !mod.modrinth} aria-label={`Switch version for ${mod.displayName}`} title={mod.modrinth ? `Switch version for ${mod.displayName}` : "Only Modrinth-managed mods can switch versions"}><AppIcon name="switch" /></Button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function InstalledModSkeletonRow() {
  return (
    <div className="modsWorkspaceRow modsWorkspaceSkeletonRow" aria-hidden="true">
      <div className="modsWorkspaceIdentity">
        <SkeletonBlock className="uiSkeleton--icon" />
        <span><SkeletonBlock className="uiSkeleton--title" /><SkeletonBlock className="uiSkeleton--text" /></span>
      </div>
      <div className="modsWorkspaceStatus"><SkeletonBlock className="uiSkeleton--badge" /></div>
      <div className="modsWorkspaceVersion"><SkeletonBlock className="uiSkeleton--text" /></div>
      <div className="modsWorkspaceUpdate"><SkeletonBlock className="modsUpdateSkeleton" /></div>
      <div className="modsWorkspaceEnabled"><SkeletonBlock className="modsToggleSkeleton" /></div>
      <SkeletonBlock className="uiSkeleton--button modsActionSkeleton" />
    </div>
  );
}

function ModUpdateCell({
  targetVersion,
  actionTone,
  children
}: {
  targetVersion?: string;
  actionTone: "update" | "review";
  children: ReactNode;
}) {
  return (
    <div className={`modsUpdateCell ${actionTone}`}>
      <div className="modsUpdateVersions">
        <span className="modsUpdateArrow" aria-hidden="true">→</span>
        <strong>{targetVersion || "Update available"}</strong>
      </div>
      {children}
    </div>
  );
}
