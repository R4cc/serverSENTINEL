import { memo, useDeferredValue, useMemo, useRef, useState, type DragEvent, type Dispatch, type ReactNode, type SetStateAction } from "react";
import type { InstalledMod, ModUpdatePlan, ModUpdatePlanEntry, RestartRequiredChange } from "../../types";
import { AppIcon } from "../../components/FileTypeIcon";
import { Button, EmptyState, LoadingLabel, PanelHeader, SkeletonBlock, Surface } from "../../components/UiPrimitives";
import { ArrowUp, Download, Puzzle } from "lucide-react";
import { modIconSource } from "../../utils/appHelpers";
import { getInstalledModHealth, modVersion } from "./modHealth";
import { applyUpdatePlanEntry, updatePlanEntryLookup } from "./modUpdatePlan";
import { ModIconImage } from "./ModIconImage";
import { filterInstalledMods } from "./modsWorkspaceHelpers";
import { buildModDependencyGraph } from "./modDependencyGraph";
import { RequiredByChip } from "./ModDependencyLinks";
import { ModStatusBadge } from "./ModStatusBadge";
import { SearchField } from "../../components/SearchField";
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
  // Built from every installed mod, not the filtered rows, so a search that hides a library's
  // parent still names it on the library's row.
  const dependencyGraph = useMemo(() => buildModDependencyGraph(mods), [mods]);
  // The row under the pointer or keyboard focus. Its libraries and dependents are tinted so the
  // relationship reads across the list without opening anything.
  const [linkSource, setLinkSource] = useState<string | null>(null);
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
          links: dependencyGraph.linksFor(mod),
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
  }, [deferredQuery, dependencyGraph, mods, restartRequiredChanges, terminology, updatePlan]);
  const linkedToSource = useMemo(() => {
    const source = linkSource ? mods.find((mod) => mod.filename === linkSource) : undefined;
    if (!source) return new Set<string>();
    const links = dependencyGraph.linksFor(source);
    return new Set([...links.requires, ...links.requiredBy].map((mod) => mod.filename));
  }, [dependencyGraph, linkSource, mods]);
  // The workspace rebuilds its action functions on every render, and it re-renders several times
  // a second while an update check reports progress. Rows reach the latest action through a ref,
  // so a memoized row only redraws when its own mod, lock state, or dependency tint changes.
  const actionsRef = useRef({ onToggle, onUpdate, onInstallDependencies, onSwitchVersion, onDetails });
  actionsRef.current = { onToggle, onUpdate, onInstallDependencies, onSwitchVersion, onDetails };
  const rowActions = useMemo<InstalledModRowActions>(() => ({
    toggle: (mod, enabled) => actionsRef.current.onToggle(mod, enabled),
    update: (mod) => actionsRef.current.onUpdate(mod),
    installDependencies: (mod) => actionsRef.current.onInstallDependencies?.(mod),
    switchVersion: (mod) => actionsRef.current.onSwitchVersion(mod),
    details: (mod) => actionsRef.current.onDetails(mod)
  }), []);
  const initialLoading = busy && mods.length === 0;
  const [draggingFiles, setDraggingFiles] = useState(false);

  function hasFiles(event: DragEvent) {
    return Array.from(event.dataTransfer.types).includes("Files");
  }

  return (
    <Surface className="modsWorkspaceInstalled" density="flush" aria-labelledby="installed-mods-title">
      <PanelHeader
        className="modsWorkspaceListHeader"
        headingId="installed-mods-title"
        title={<><span className="modsSectionIcon" aria-hidden="true"><Puzzle /></span>Installed {terminology.plural}</>}
        description={<span role="status">{initialLoading ? <SkeletonBlock className="modsTotalSkeleton" /> : deferredQuery.trim() ? `${visible.length} of ${mods.length}` : `${mods.length} total`}</span>}
        actions={<div className="modsWorkspaceSearch">
          <SearchField label={`Search installed ${terminology.plural}`} value={query} onChange={onQueryChange} disabled={initialLoading} />
        </div>}
      />

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
          <span>{terminology.singularTitle}</span><span>Status</span><span>Installed version</span><span>Update</span><span>Enabled</span><span>Actions</span>
        </div>
        {initialLoading && <LoadingLabel>Loading installed {terminology.plural}</LoadingLabel>}
        {initialLoading ? (
          Array.from({ length: 5 }, (_, index) => <InstalledModSkeletonRow key={index} />)
        ) : visible.length === 0 ? (
          <EmptyState compact className="modsWorkspaceEmpty" title={mods.length ? `No matching ${terminology.plural}` : `No ${terminology.plural} installed yet`} message={mods.length ? "Try a different search." : `Add a compatible ${terminology.runtimeName} ${terminology.singular} or upload a jar to get started.`} />
        ) : visible.map((item) => (
          <InstalledModRow
            key={item.mod.filename}
            item={item}
            terminology={terminology}
            locked={locked}
            switchLocked={switchLocked}
            dependencyInstallLocked={dependencyInstallLocked}
            linked={linkedToSource.has(item.mod.filename)}
            linkSource={linkSource === item.mod.filename && linkedToSource.size > 0}
            setLinkSource={setLinkSource}
            actions={rowActions}
          />
        ))}
      </div>
    </Surface>
  );
}

type InstalledModRowItem = {
  mod: InstalledMod;
  links: ReturnType<ReturnType<typeof buildModDependencyGraph>["linksFor"]>;
  plannedUpdate: ModUpdatePlanEntry | null;
  installedVersion: string;
  health: ReturnType<typeof getInstalledModHealth>;
  requiresRestart: boolean;
};

type InstalledModRowActions = {
  toggle: (mod: InstalledMod, enabled: boolean) => void;
  update: (mod: InstalledMod) => void;
  installDependencies: (mod: InstalledMod) => void;
  switchVersion: (mod: InstalledMod) => void;
  details: (mod: InstalledMod) => void;
};

const InstalledModRow = memo(function InstalledModRow({
  item: { mod, links, plannedUpdate, installedVersion, health, requiresRestart },
  terminology,
  locked,
  switchLocked,
  dependencyInstallLocked,
  linked,
  linkSource,
  setLinkSource,
  actions
}: {
  item: InstalledModRowItem;
  terminology: ManagedContentTerminology;
  locked: boolean;
  switchLocked: boolean;
  dependencyInstallLocked: boolean;
  linked: boolean;
  linkSource: boolean;
  setLinkSource: Dispatch<SetStateAction<string | null>>;
  actions: InstalledModRowActions;
}) {
    const targetVersion = plannedUpdate?.targetVersion || mod.versionInfo?.latestVersion;
    const icon = modIconSource(mod.iconUrl);
    const hasLinks = links.requires.length > 0 || links.requiredBy.length > 0;
    const rowState = [
      mod.enabled ? "" : "isDisabled",
      linked ? "isDependencyLinked" : "",
      linkSource ? "isDependencySource" : ""
    ].filter(Boolean).join(" ");
    return (
      <article
        key={mod.filename}
        className={`modsWorkspaceRow ${rowState}`.trim()}
        role="listitem"
        onPointerEnter={() => setLinkSource(hasLinks ? mod.filename : null)}
        onPointerLeave={() => setLinkSource((current) => current === mod.filename ? null : current)}
        onFocus={() => setLinkSource(hasLinks ? mod.filename : null)}
        onBlur={(event) => {
          if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
          setLinkSource((current) => current === mod.filename ? null : current);
        }}
      >
        <button type="button" className="modsWorkspaceIdentity" onClick={() => actions.details(mod)} title={`Open details for ${mod.displayName}`}>
          <ModIconImage src={icon} fallback="JAR" />
          <span><strong title={mod.displayName}>{mod.displayName}</strong>{mod.description && <small title={mod.description}>{mod.description}</small>}</span>
          <AppIcon name="chevronRight" />
        </button>
        <div className="modsWorkspaceMetadata">
          <div className="modsWorkspaceStatus">
            {health.tone === "ready"
              ? <span className="modsHealthQuiet"><span className="modsHealthQuietDot" aria-hidden="true" />{health.label}</span>
              : <ModStatusBadge tone={health.tone}>{health.label}</ModStatusBadge>}
            {requiresRestart && <ModStatusBadge tone="restart">Requires restart</ModStatusBadge>}
            <RequiredByChip mod={mod} requiredBy={links.requiredBy} terminology={terminology} onOpen={actions.details} />
          </div>
          <div className="modsWorkspaceVersion" title={installedVersion}>{installedVersion}</div>
        </div>
        <div className="modsWorkspaceUpdate">
          {health.key === "missing_dependencies" && (
            <Button variant="secondary" compact className="modsReviewAction" onClick={() => actions.installDependencies(mod)} disabled={dependencyInstallLocked} title={health.detailDescription}>
              Install dependencies
            </Button>
          )}
          {plannedUpdate?.status === "safe_update" && (
            <ModUpdateCell targetVersion={targetVersion} actionTone="update">
              <Button variant="primary" compact className="modsUpdateAction" onClick={() => actions.update(mod)} disabled={locked} title={`Download and install${targetVersion ? ` ${targetVersion}` : " the available update"}`}>
                <Download aria-hidden="true" />
                <span className="modsUpdateActionLabel">Update</span>
                <span className="srOnly"> {mod.displayName}</span>
              </Button>
            </ModUpdateCell>
          )}
          {plannedUpdate?.status === "needs_review" && (
            <ModUpdateCell targetVersion={targetVersion} actionTone="review">
              <Button variant="secondary" compact className="modsReviewAction" onClick={() => actions.details(mod)} disabled={locked} title={health.shortDescription}>
                {health.primaryActionLabel}
              </Button>
            </ModUpdateCell>
          )}
        </div>
        <div className="modsWorkspaceEnabled">
          <label className="switch modsWorkspaceSwitch">
            <input type="checkbox" checked={mod.enabled} onChange={() => actions.toggle(mod, !mod.enabled)} disabled={locked} aria-label={`${mod.enabled ? "Disable" : "Enable"} ${mod.displayName}`} />
            <span className="slider" />
          </label>
        </div>
        <Button variant="ghost" iconOnly className="modsWorkspaceSwitchVersionButton" onClick={() => actions.switchVersion(mod)} disabled={switchLocked || !mod.modrinth} aria-label={`Switch version for ${mod.displayName}`} title={mod.modrinth ? `Switch version for ${mod.displayName}` : `Only Modrinth-managed ${terminology.plural} can switch versions`}><AppIcon name="switch" /></Button>
      </article>
    );
});

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
        <span className="modsUpdateArrow" aria-hidden="true"><ArrowUp /></span>
        <strong title={targetVersion || "Update available"}>{targetVersion || "Available"}</strong>
      </div>
      {children}
    </div>
  );
}
