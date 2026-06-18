import type { InstalledMod } from "../../types";
import { AppIcon } from "../../components/FileTypeIcon";
import { formatBytes } from "../../utils/format";
import { modIconSource } from "../../utils/appHelpers";
import { installedModStatus, installedModUpdateState, modVersion } from "./modStatus";

type Props = {
  mod: InstalledMod;
  locked: boolean;
  formatDate: (value: string | number | Date) => string;
  onClose: () => void;
  onToggle: (mod: InstalledMod, enabled: boolean) => void;
  onUpdate: (mod: InstalledMod) => void;
  onRemove: (mod: InstalledMod) => void;
};

export function ModDetailsPanel({ mod, locked, formatDate, onClose, onToggle, onUpdate, onRemove }: Props) {
  const status = installedModStatus(mod);
  const update = installedModUpdateState(mod);
  const icon = modIconSource(mod.iconUrl);
  return (
    <aside className="modsDetailsDrawer" role="dialog" aria-modal="true" aria-labelledby="mod-details-title">
      <div className="modsDrawerHeader">
        <div className="modsDetailsTitle">
          {icon ? <img src={icon} alt="" /> : <span className="modsWorkspaceFallback">JAR</span>}
          <div><h2 id="mod-details-title">{mod.displayName}</h2><span className={`modsStatusChip ${status.key}`}>{status.label}</span></div>
        </div>
        <button type="button" className="iconButton" onClick={onClose} aria-label="Close mod details"><AppIcon name="x" /></button>
      </div>
      <div className="modsDrawerBody">
        {mod.description && <p className="modsDetailsDescription">{mod.description}</p>}
        <dl className="modsDetailsFacts">
          <div><dt>Installed version</dt><dd>{modVersion(mod)}</dd></div>
          {update === "available" && <div><dt>Latest version</dt><dd>{mod.versionInfo?.latestVersion} <span className="modsStatusChip review">Update available</span></dd></div>}
          <div><dt>Source</dt><dd>{mod.modrinth ? "Modrinth" : "Manual upload"}</dd></div>
          <div><dt>Filename</dt><dd>{mod.filename}</dd></div>
          <div><dt>File size</dt><dd>{formatBytes(mod.size)}</dd></div>
          <div><dt>Modified</dt><dd>{formatDate(mod.modifiedAt)}</dd></div>
        </dl>
        <section className={`modsCompatibilityCard ${status.key}`}>
          <strong>{status.label}</strong>
          <p>{status.description}</p>
          {mod.compatibility && (
            <details>
              <summary>Technical compatibility details</summary>
              <dl>
                <div><dt>Raw status</dt><dd>{mod.compatibility.status}</dd></div>
                <div><dt>Server side</dt><dd>{mod.compatibility.serverSide || "Unknown"}</dd></div>
                <div><dt>Client side</dt><dd>{mod.compatibility.clientSide || "Unknown"}</dd></div>
                {mod.compatibility.matchedGameVersions?.length && <div><dt>Game versions</dt><dd>{mod.compatibility.matchedGameVersions.join(", ")}</dd></div>}
                {mod.compatibility.matchedLoaders?.length && <div><dt>Loaders</dt><dd>{mod.compatibility.matchedLoaders.join(", ")}</dd></div>}
              </dl>
            </details>
          )}
        </section>
        {mod.modrinth && (
          <details className="modsTechnicalDetails">
            <summary>Modrinth metadata</summary>
            <dl className="modsDetailsFacts">
              <div><dt>Project ID</dt><dd>{mod.modrinth.projectId}</dd></div>
              <div><dt>Version ID</dt><dd>{mod.modrinth.versionId}</dd></div>
              <div><dt>Installed</dt><dd>{formatDate(mod.modrinth.installedAt)}</dd></div>
              <div><dt>Game versions</dt><dd>{mod.modrinth.gameVersions.join(", ") || "Unknown"}</dd></div>
              <div><dt>Loaders</dt><dd>{mod.modrinth.loaders.join(", ") || "Unknown"}</dd></div>
            </dl>
            {mod.modrinth.hashes && Object.entries(mod.modrinth.hashes).map(([name, hash]) => <code key={name}>{name}: {hash}</code>)}
            <a href={`https://modrinth.com/mod/${mod.modrinth.projectId}`} target="_blank" rel="noreferrer">View on Modrinth</a>
          </details>
        )}
      </div>
      <div className="modsDrawerFooter">
        {update === "available" && <button type="button" onClick={() => onUpdate(mod)} disabled={locked}>{status.key === "ready" ? `Update to ${mod.versionInfo?.latestVersion}` : `Update anyway to ${mod.versionInfo?.latestVersion}`}</button>}
        <button type="button" className="secondaryButton" onClick={() => onToggle(mod, !mod.enabled)} disabled={locked}>{mod.enabled ? "Disable" : "Enable"}</button>
        <button type="button" className="dangerButton" onClick={() => onRemove(mod)} disabled={locked}>Remove</button>
      </div>
    </aside>
  );
}
