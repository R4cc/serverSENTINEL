import { useDeferredValue, useMemo, useState, type DragEvent, type ReactNode } from "react";
import type { InstalledMod, ModUpdatePlan, RestartRequiredChange } from "../../types";
import { AppIcon } from "../../components/FileTypeIcon";
import { Button, EmptyState, LoadingLabel, SkeletonBlock } from "../../components/UiPrimitives";
import { modIconSource } from "../../utils/appHelpers";
import { getInstalledModHealth, modVersion } from "./modHealth";
import { applyUpdatePlanEntry, updatePlanEntryLookup } from "./modUpdatePlan";
import { ModIconImage } from "./ModIconImage";
import { filterInstalledMods } from "./modsWorkspaceHelpers";
import { ModStatusBadge } from "./ModStatusBadge";
import { fabricContentTerminology, type ManagedContentTerminology } from "./contentTerminology";

type Props = {
  terminology?: ManagedContentTerminology;
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

function canonicalModFilename(filename: string) {
  return filename.replace(/\.jar\.disabled$/i, ".jar").toLowerCase();
}

export function InstalledModsList({ terminology = fabricContentTerminology, mods, restartRequiredChanges = [], query, busy, locked, switchLocked = locked, dependencyInstallLocked = locked, onQueryChange, onToggle, onUpdate, onInstallDependencies, onSwitchVersion, onDetails, onDropFiles, dropLocked = false, updatePlan }: Props) {
  const deferredQuery = useDeferredValue(query);
  // Filtering, health resolution, and sorting cost more than the rows they feed, and the parent
  // re-renders for reasons that have nothing to do with this list. Deferring the query keeps the
  // search control responsive even when a large installation has hundreds of rows to rank.
  const visible = useMemo(() => {
    const plannedUpdateFor = updatePlanEntryLookup(updatePlan ?? null);
    const restartIdentities = new Set<string>();
    const restartFilenames = new Set<string>();
    for (const change of restartRequiredChanges) {
      if (change.action === "removed") continue;
      restartIdentities.add(change.identity);
      if (change.filename) restartFilenames.add(canonicalModFilename(change.filename));
    }
    return filterInstalledMods(mods, deferredQuery)
      .map((mod) => {
        const plannedUpdate = plannedUpdateFor(mod);
        const filename = canonicalModFilename(mod.filename);
        const identity = mod.modrinth?.projectId ? `modrinth:${mod.modrinth.projectId}` : `file:${filename}`;
        return {
          mod,
          plannedUpdate,
          installedVersion: modVersion(mod),
          health: getInstalledModHealth(applyUpdatePlanEntry(mod, plannedUpdate), terminology),
          requiresRestart: restartIdentities.has(identity) || restartFilenames.has(filename),
          updateAvailable: plannedUpdate
            ? plannedUpdate.status === "safe_update" || plannedUpdate.status === "needs_review"
            : mod.versionInfo?.upToDate === false && Boolean(mod.versionInfo.latestVersion)
        };
      })
      .sort((a, b) => Number(b.updateAvailable) - Number(a.updateAvailable));
  }, [deferredQuery, mods, restartRequiredChanges, terminology, updatePlan]);
  const initialLoading = busy && mods.length === 0;
  const [draggingFiles, setDraggingFiles] = useState(false);

  function hasFiles(event: DragEvent) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  return (
    <section className="modsWorkspaceInstalled" aria-labelledby="installed-mods-title">
      <div className="modsWorkspaceListHeader">
        <div>
          <h2 id="installed-mods-title">Installed {terminology.plural}</h2>
          <span>{initialLoading ? <SkeletonBlock className="modsTotalSkeleton" /> : `${mods.length} total`}</span>
        </div>
        <label className="modsWorkspaceSearch">
          <AppIcon name="search" />
          <span className="srOnly">Search installed {terminology.plural}</span>
          <input type="search" autoComplete="off" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder={`Search installed ${terminology.plural}`} disabled={initialLoading} />
        </label>
      </div>

      <div
        className={`modsWorkspaceTable ${draggingFiles ? "isDragTarget" : ""}`}
        role={!initialLoading && visible.length > 0 ? "list" : undefined}
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
        <div className="modsWorkspaceTableHead uiTableHeader" aria-hidden="true">
          <span>{terminology.singularTitle}</span><span>Status</span><span>Installed version</span><span>Update</span><span>Enabled</span><span />
        </div>
        {initialLoading && <LoadingLabel>Loading installed {terminology.plural}</LoadingLabel>}
        {initialLoading ? (
          Array.from({ length: 5 }, (_, index) => <InstalledModSkeletonRow key={index} />)
        ) : visible.length === 0 ? (
          <EmptyState compact className="modsWorkspaceEmpty" title={mods.length ? `No matching ${terminology.plural}` : `No ${terminology.plural} installed yet`} message={mods.length ? "Try a different search." : `Add a compatible ${terminology.runtimeName} ${terminology.singular} or upload a jar to get started.`} />
        ) : visible.map(({ mod, plannedUpdate, installedVersion, health, requiresRestart }) => {
          const targetVersion = plannedUpdate?.targetVersion || mod.versionInfo?.latestVersion;
          const icon = modIconSource(mod.iconUrl);
          return (
            <article
              key={mod.filename}
              className={`modsWorkspaceRow ${mod.enabled ? "" : "isDisabled"}`}
              role="listitem"
            >
              <button type="button" className="modsWorkspaceIdentity" onClick={() => onDetails(mod)} title={`Open details for ${mod.displayName}`}>
                <ModIconImage src={icon} fallback="JAR" />
                <span><strong title={mod.displayName}>{mod.displayName}</strong>{mod.description && <small title={mod.description}>{mod.description}</small>}</span>
                <AppIcon name="chevronRight" />
              </button>
              <div className="modsWorkspaceMetadata">
                <div className="modsWorkspaceStatus"><ModStatusBadge tone={health.tone}>{health.label}</ModStatusBadge>{requiresRestart && <ModStatusBadge tone="update">Requires restart</ModStatusBadge>}</div>
                <div className="modsWorkspaceVersion" title={installedVersion}>{installedVersion}</div>
              </div>
              <div className="modsWorkspaceUpdate">
                {health.key === "missing_dependencies" && (
                  <Button variant="secondary" compact className="modsReviewAction" onClick={() => onInstallDependencies?.(mod)} disabled={dependencyInstallLocked} title={health.detailDescription}>
                    Install dependencies
                  </Button>
                )}
                {plannedUpdate?.status === "safe_update" && (
                  <Button variant="secondary" compact className="modsUpdateAction" onClick={() => onUpdate(mod)} disabled={locked} title={`Download and install${targetVersion ? ` ${targetVersion}` : " the available update"}`}>
                    <span className="modsUpdateTransition">
                      <span className="modsUpdateArrow">→</span>
                      <strong title={targetVersion || "Update available"}>{targetVersion || "Available"}</strong>
                    </span>
                    <span className="modsUpdateActionLabel">Update</span>
                    <span className="srOnly"> {mod.displayName}</span>
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
              <Button variant="ghost" iconOnly className="modsWorkspaceSwitchVersionButton" onClick={() => onSwitchVersion(mod)} disabled={switchLocked || !mod.modrinth} aria-label={`Switch version for ${mod.displayName}`} title={mod.modrinth ? `Switch version for ${mod.displayName}` : `Only Modrinth-managed ${terminology.plural} can switch versions`}><AppIcon name="switch" /></Button>
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
      <div className="modsWorkspaceMetadata">
        <div className="modsWorkspaceStatus"><SkeletonBlock className="uiSkeleton--badge" /></div>
        <div className="modsWorkspaceVersion"><SkeletonBlock className="uiSkeleton--text" /></div>
      </div>
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
        <strong title={targetVersion || "Update available"}>{targetVersion || "Update available"}</strong>
      </div>
      {children}
    </div>
  );
}
