import type { InstalledMod, ModUpdatePlan } from "../../types";
import { AppIcon } from "../../components/FileTypeIcon";
import { modIconSource } from "../../utils/appHelpers";
import { getInstalledModHealth, modVersion } from "./modHealth";
import { updatePlanEntryForMod } from "./modUpdatePlan";
import { filterInstalledMods } from "./modsWorkspaceHelpers";

type Props = {
  mods: InstalledMod[];
  query: string;
  busy: boolean;
  locked: boolean;
  onQueryChange: (value: string) => void;
  onToggle: (mod: InstalledMod, enabled: boolean) => void;
  onUpdate: (mod: InstalledMod) => void;
  onDetails: (mod: InstalledMod) => void;
  updatePlan?: ModUpdatePlan | null;
};

export function InstalledModsList({ mods, query, busy, locked, onQueryChange, onToggle, onUpdate, onDetails, updatePlan }: Props) {
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
          <span>Mod</span><span>Status</span><span>Installed version</span><span>Update</span><span>Enabled</span><span />
        </div>
        {visible.length === 0 ? (
          <div className="modsWorkspaceEmpty">
            <strong>{mods.length ? "No matching mods" : "No mods installed yet"}</strong>
            <span>{mods.length ? "Try a different search." : "Add a compatible Fabric mod or upload a jar to get started."}</span>
          </div>
        ) : visible.map((mod) => {
          const health = getInstalledModHealth(mod);
          const plannedUpdate = updatePlanEntryForMod(updatePlan ?? null, mod);
          const icon = modIconSource(mod.iconUrl);
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
                {icon ? <img src={icon} alt="" /> : <span className="modsWorkspaceFallback">JAR</span>}
                <span><strong>{mod.displayName}</strong>{mod.description && <small>{mod.description}</small>}</span>
              </button>
              <div><span className={`modsStatusChip ${health.tone}`}>{health.label}</span></div>
              <div className="modsWorkspaceVersion">{modVersion(mod)}</div>
              <div className="modsWorkspaceUpdate">
                {plannedUpdate?.status === "safe_update" && (
                  <button type="button" className="modsUpdateAction" onClick={() => onUpdate(mod)} disabled={locked} title={health.shortDescription}>
                    {health.primaryActionLabel}
                  </button>
                )}
                {plannedUpdate?.status === "needs_review" && (
                  <button type="button" className="modsReviewAction" onClick={() => onDetails(mod)} disabled={locked} title={health.shortDescription}>
                    {health.primaryActionLabel}
                  </button>
                )}
              </div>
              <div>
                <label className="switch modsWorkspaceSwitch">
                  <input type="checkbox" checked={mod.enabled} onChange={() => onToggle(mod, !mod.enabled)} disabled={locked} aria-label={`${mod.enabled ? "Disable" : "Enable"} ${mod.displayName}`} />
                  <span className="slider" />
                </label>
              </div>
              <button type="button" className="modsWorkspaceDetailsButton" onClick={() => onDetails(mod)} aria-label={`More options for ${mod.displayName}`}><AppIcon name="chevronRight" /></button>
            </article>
          );
        })}
      </div>
    </section>
  );
}
