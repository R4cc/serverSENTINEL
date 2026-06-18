import type { InstalledMod } from "../../types";
import { AppIcon } from "../../components/FileTypeIcon";
import { modIconSource } from "../../utils/appHelpers";
import { installedModStatus, installedModUpdateState, modVersion } from "./modStatus";

type Props = {
  mods: InstalledMod[];
  query: string;
  busy: boolean;
  locked: boolean;
  onQueryChange: (value: string) => void;
  onToggle: (mod: InstalledMod, enabled: boolean) => void;
  onUpdate: (mod: InstalledMod) => void;
  onDetails: (mod: InstalledMod) => void;
};

export function InstalledModsList({ mods, query, busy, locked, onQueryChange, onToggle, onUpdate, onDetails }: Props) {
  const normalized = query.trim().toLowerCase();
  const visible = [...mods]
    .filter((mod) => !normalized || `${mod.displayName} ${mod.filename} ${mod.description || ""}`.toLowerCase().includes(normalized))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return (
    <section className="modsWorkspaceInstalled" aria-labelledby="installed-mods-title">
      <div className="modsWorkspaceListHeader">
        <div>
          <h3 id="installed-mods-title">Installed mods</h3>
          <span>{mods.length} total</span>
        </div>
        <label className="modsWorkspaceSearch">
          <AppIcon name="search" />
          <span className="srOnly">Search installed mods</span>
          <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search mods…" />
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
          const status = installedModStatus(mod);
          const update = installedModUpdateState(mod);
          const icon = modIconSource(mod.iconUrl);
          return (
            <article key={mod.filename} className={`modsWorkspaceRow ${mod.enabled ? "" : "isDisabled"}`}>
              <button type="button" className="modsWorkspaceIdentity" onClick={() => onDetails(mod)} aria-label={`Open details for ${mod.displayName}`}>
                {icon ? <img src={icon} alt="" /> : <span className="modsWorkspaceFallback">JAR</span>}
                <span><strong>{mod.displayName}</strong>{mod.description && <small>{mod.description}</small>}</span>
              </button>
              <div><span className={`modsStatusChip ${status.key}`}>{status.label}</span></div>
              <div className="modsWorkspaceVersion">{modVersion(mod)}</div>
              <div className="modsWorkspaceUpdate">
                {update === "available" && (
                  <button type="button" className={status.key === "ready" ? "modsUpdateAction" : "modsReviewAction"} onClick={() => status.key === "ready" ? onUpdate(mod) : onDetails(mod)} disabled={locked}>
                    {status.key === "ready" ? `Update to ${mod.versionInfo?.latestVersion}` : "Review update"}
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
