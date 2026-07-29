import { useId } from "react";
import { EXPORT_CATEGORY_DESCRIPTORS, type ExportCategory } from "@serversentinel/contracts";
import { AppIcon } from "../../components/FileTypeIcon";
import { Banner, Button, Spinner } from "../../components/UiPrimitives";
import { DialogSurface } from "../../components/DialogSurface";
import { formatBytes } from "../../utils/format";
import type { ManagedServer } from "../../types";
import type { ExportWorkspace } from "./useExportWorkspace";

function categoryBytes(workspace: ExportWorkspace, category: ExportCategory) {
  if (!workspace.estimate) return undefined;
  return workspace.estimate.servers.reduce((total, server) => {
    const match = server.categories.find((entry) => entry.category === category);
    return total + (match?.bytes ?? 0);
  }, 0);
}

export function ExportModal({
  workspace,
  servers
}: {
  workspace: ExportWorkspace;
  servers: ManagedServer[];
}) {
  const titleId = useId();
  const descriptionId = useId();
  const runningServers = workspace.estimate?.servers.filter((server) => server.running) ?? [];
  const contentSelected = workspace.categories.includes("content");
  const worldSelected = workspace.categories.includes("world");
  const canSubmit = workspace.categories.length > 0 && !workspace.exportBusy && runningServers.length === 0;

  return (
    <DialogSurface
      backdrop
      className="modalPanel exportModalPanel"
      labelledBy={titleId}
      describedBy={descriptionId}
      onClose={workspace.closeExport}
      dismissible={!workspace.exportBusy}
    >
      <header className="modalHeader">
        <h2 id={titleId}>Export servers</h2>
        <Button
          variant="secondary"
          iconOnly
          className="iconButton modalCloseButton"
          onClick={workspace.closeExport}
          disabled={workspace.exportBusy}
          aria-label="Close export dialog"
          title="Close dialog"
        >
          <AppIcon name="x" />
        </Button>
      </header>

      <div className="modalBody exportModalBody">
        <p id={descriptionId} className="uiFormFieldDescription">
          Choose what to include. The download is a single ZIP archive you can import back into this
          panel or another one.
        </p>

        {runningServers.length > 0 && (
          <Banner
            tone="warning"
            title="Stop the server before exporting"
            message={`${runningServers.map((server) => server.displayName).join(", ")} ${runningServers.length === 1 ? "is" : "are"} running. A world copied while the server is running can contain half-written chunks.`}
          />
        )}

        <fieldset className="exportCategoryList">
          <legend className="uiFormFieldLabel"><span>Include</span></legend>
          {EXPORT_CATEGORY_DESCRIPTORS.map((descriptor) => {
            const bytes = categoryBytes(workspace, descriptor.key);
            return (
              <label key={descriptor.key} className="exportCategoryOption">
                <input
                  type="checkbox"
                  checked={workspace.categories.includes(descriptor.key)}
                  disabled={workspace.exportBusy}
                  onChange={() => workspace.toggleCategory(descriptor.key)}
                />
                <span className="exportCategoryCopy">
                  <strong>{descriptor.label}</strong>
                  <small>{descriptor.description}</small>
                </span>
                <span className="exportCategorySize">
                  {workspace.categories.includes(descriptor.key) && bytes !== undefined ? formatBytes(bytes) : ""}
                </span>
              </label>
            );
          })}
        </fieldset>

        {contentSelected && (
          <fieldset className="exportStrategy">
            <legend className="uiFormFieldLabel"><span>Mods and plugins</span></legend>
            <label className="exportCategoryOption">
              <input
                type="radio"
                name="contentStrategy"
                checked={workspace.contentStrategy === "lockfile"}
                disabled={workspace.exportBusy}
                onChange={() => workspace.setContentStrategy("lockfile")}
              />
              <span className="exportCategoryCopy">
                <strong>Re-download from Modrinth</strong>
                <small>Records the exact versions instead of the files. Much smaller, but needs Modrinth when importing.</small>
              </span>
            </label>
            <label className="exportCategoryOption">
              <input
                type="radio"
                name="contentStrategy"
                checked={workspace.contentStrategy === "jars"}
                disabled={workspace.exportBusy}
                onChange={() => workspace.setContentStrategy("jars")}
              />
              <span className="exportCategoryCopy">
                <strong>Include the files</strong>
                <small>Carries every jar. Larger, but restores without Modrinth and keeps custom builds.</small>
              </span>
            </label>
          </fieldset>
        )}

        {servers.length > 1 && (
          <fieldset className="exportServerList">
            <legend className="uiFormFieldLabel"><span>Servers</span></legend>
            <label className="exportCategoryOption">
              <input
                type="checkbox"
                checked={workspace.selectedServerIds.length === 0}
                disabled={workspace.exportBusy}
                onChange={() => workspace.setSelectedServerIds([])}
              />
              <span className="exportCategoryCopy"><strong>All servers</strong></span>
            </label>
            {servers.map((server) => (
              <label key={server.id} className="exportCategoryOption">
                <input
                  type="checkbox"
                  checked={workspace.selectedServerIds.includes(server.id)}
                  disabled={workspace.exportBusy}
                  onChange={() => workspace.setSelectedServerIds(
                    workspace.selectedServerIds.includes(server.id)
                      ? workspace.selectedServerIds.filter((id) => id !== server.id)
                      : [...workspace.selectedServerIds, server.id]
                  )}
                />
                <span className="exportCategoryCopy"><strong>{server.displayName}</strong></span>
              </label>
            ))}
          </fieldset>
        )}

        <div className="exportEstimate">
          {workspace.estimating ? (
            <span className="exportEstimateLine"><Spinner /> Measuring selection…</span>
          ) : workspace.estimate ? (
            <span className="exportEstimateLine">
              <strong>{formatBytes(workspace.estimate.totalBytes)}</strong> before compression
              {workspace.estimate.availableBytes !== undefined && (
                <> · {formatBytes(workspace.estimate.availableBytes)} free on the panel</>
              )}
            </span>
          ) : null}
          {worldSelected && (
            <small>Worlds are usually most of the archive. Datapacks are inside the world folder and travel with it.</small>
          )}
        </div>

        {workspace.exportBusy && (
          <div className="exportProgress" role="status">
            <progress value={workspace.exportProgress} max={100} />
            <span>{workspace.exportTask || "Working…"}</span>
          </div>
        )}

        {workspace.exportWarnings.length > 0 && (
          <Banner
            tone="info"
            title="Finished with notes"
            message={workspace.exportWarnings.join(" ")}
          />
        )}

        {workspace.artifact && (
          <Banner
            tone="success"
            title="Export ready"
            message={`${workspace.artifact.filename} · ${formatBytes(workspace.artifact.size)}`}
            action={<a className="uiButton uiButton--primary" href={workspace.artifact.downloadUrl} download>Download</a>}
          />
        )}

        {workspace.exportError && <Banner tone="error" title="Export failed" message={workspace.exportError} />}
      </div>

      <footer className="modalFooter">
        <Button variant="secondary" onClick={workspace.closeExport} disabled={workspace.exportBusy}>
          {workspace.artifact ? "Done" : "Cancel"}
        </Button>
        <Button variant="primary" onClick={() => void workspace.runExport()} disabled={!canSubmit}>
          {workspace.exportBusy ? "Exporting…" : workspace.artifact ? "Export again" : "Export"}
        </Button>
      </footer>
    </DialogSurface>
  );
}
