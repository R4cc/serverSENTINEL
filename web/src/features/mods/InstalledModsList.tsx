import type { ReactNode } from "react";
import type { InstalledMod, ModUpdatePlan, RestartRequiredChange } from "../../types";
import { AppIcon } from "../../components/FileTypeIcon";
import { Button, EmptyState } from "../../components/UiPrimitives";
import { modIconSource } from "../../utils/appHelpers";
import { getInstalledModHealth, modVersion } from "./modHealth";
import { updatePlanEntryForMod } from "./modUpdatePlan";
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
  onQueryChange: (value: string) => void;
  onToggle: (mod: InstalledMod, enabled: boolean) => void;
  onUpdate: (mod: InstalledMod) => void;
  onSwitchVersion: (mod: InstalledMod) => void;
  onDetails: (mod: InstalledMod) => void;
  updatePlan?: ModUpdatePlan | null;
};

export function InstalledModsList({ mods, restartRequiredChanges = [], query, busy, locked, switchLocked = locked, onQueryChange, onToggle, onUpdate, onSwitchVersion, onDetails, updatePlan }: Props) {
  const visible = filterInstalledMods(mods, query);

  return (
    <section className="modsWorkspaceInstalled" aria-labelledby="installed-mods-title">
      <div className="modsWorkspaceListHeader">
        <div>
          <h3 id="installed-mods-title">Installed mods</h3>
          <span>{mods.length} total</span>
        </div>
        <label className="modsWorkspaceSearch">
          <AppIcon name="search" />
          <span className="srOnly">Search</span>
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search" />
        </label>
      </div>

      <div className="modsWorkspaceTable" aria-busy={busy}>
        <div className="modsWorkspaceTableHead" aria-hidden="true">
          <span>Mod</span><span>Status</span><span>Installed version</span><span>Update</span><span>Enabled</span><span /><span />
        </div>
        {visible.length === 0 ? (
          <EmptyState compact className="modsWorkspaceEmpty" title={mods.length ? "No matching mods" : "No mods installed yet"} message={mods.length ? "Try a different search." : "Add a compatible Fabric mod or upload a jar to get started."} />
        ) : visible.map((mod) => {
          const health = getInstalledModHealth(mod);
          const plannedUpdate = updatePlanEntryForMod(updatePlan ?? null, mod);
          const currentVersion = plannedUpdate?.currentVersion || modVersion(mod);
          const targetVersion = plannedUpdate?.targetVersion || mod.versionInfo?.latestVersion;
          const icon = modIconSource(mod.iconUrl);
          const identity = mod.modrinth?.projectId ? `modrinth:${mod.modrinth.projectId}` : `file:${mod.filename.replace(/\.jar\.disabled$/i, ".jar").toLowerCase()}`;
          const requiresRestart = restartRequiredChanges.some((change) => change.identity === identity && change.action !== "removed");
          return (
            <article
              key={mod.filename}
              className={`modsWorkspaceRow ${mod.enabled ? "" : "isDisabled"}`}
              onClick={(event) => {
                const target = event.target as HTMLElement;
                if (!target.closest("button, input, label, a, summary, details")) onDetails(mod);
              }}
            >
              <button type="button" className="modsWorkspaceIdentity" onClick={() => onDetails(mod)} aria-label={`Open details for ${mod.displayName}`}>
                <ModIconImage src={icon} fallback="JAR" />
                <span><strong>{mod.displayName}</strong>{mod.description && <small>{mod.description}</small>}</span>
              </button>
              <div className="modsWorkspaceStatus"><ModStatusBadge tone={health.tone}>{health.label}</ModStatusBadge>{requiresRestart && <ModStatusBadge tone="update">Requires restart</ModStatusBadge>}</div>
              <div className="modsWorkspaceVersion">{modVersion(mod)}</div>
              <div className="modsWorkspaceUpdate">
                {plannedUpdate?.status === "safe_update" && (
                  <ModUpdateCell currentVersion={currentVersion} targetVersion={targetVersion} actionTone="update">
                    <Button variant="secondary" compact className="modsUpdateAction" onClick={() => onUpdate(mod)} disabled={locked} title={health.shortDescription}>
                      {health.primaryActionLabel}
                    </Button>
                  </ModUpdateCell>
                )}
                {plannedUpdate?.status === "needs_review" && (
                  <ModUpdateCell currentVersion={currentVersion} targetVersion={targetVersion} actionTone="review">
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
              <Button variant="ghost" iconOnly className="modsWorkspaceDetailsButton" onClick={() => onDetails(mod)} aria-label={`More options for ${mod.displayName}`}><AppIcon name="chevronRight" /></Button>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function ModUpdateCell({
  currentVersion,
  targetVersion,
  actionTone,
  children
}: {
  currentVersion: string;
  targetVersion?: string;
  actionTone: "update" | "review";
  children: ReactNode;
}) {
  return (
    <div className={`modsUpdateCell ${actionTone}`}>
      <div className="modsUpdateVersions">
        <span className="modsUpdateCurrent">{currentVersion || "Unknown"}</span>
        <span className="modsUpdateTo">update to</span>
        <strong>{targetVersion || "Update available"}</strong>
      </div>
      {children}
    </div>
  );
}
