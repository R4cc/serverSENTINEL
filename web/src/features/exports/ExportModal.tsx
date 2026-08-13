import { useId } from "react";
import { EXPORT_CATEGORY_DESCRIPTORS, type ExportCategory } from "@serversentinel/contracts";
import { AppIcon } from "../../components/FileTypeIcon";
import { Banner, Button, Spinner } from "../../components/UiPrimitives";
import { DialogSurface } from "../../components/DialogSurface";
import { formatAdaptiveBytes } from "../../utils/format";
import type { ManagedServer } from "../../types";
import type { ExportWorkspace } from "./useExportWorkspace";

function categoryBytes(workspace: ExportWorkspace, category: ExportCategory) {
  if (!workspace.estimate) return undefined;
  return workspace.estimate.servers.reduce((total, server) => {
    const match = server.categories.find((entry) => entry.category === category);
    return total + (match?.bytes ?? 0);
  }, 0);
}

function ExportSize({ bytes, className }: { bytes: number; className?: string }) {
  const exactSize = `${bytes.toLocaleString()} ${bytes === 1 ? "byte" : "bytes"}`;
  return (
    <span className={["exportSizeValue", className].filter(Boolean).join(" ")} title={exactSize}>
      {formatAdaptiveBytes(bytes)}
    </span>
  );
}

export function ExportModal({
  workspace,
  server
}: {
  workspace: ExportWorkspace;
  server: ManagedServer;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const running = workspace.estimate?.servers.some((entry) => entry.running) ?? false;
  const contentSelected = workspace.categories.includes("content");
  const worldSelected = workspace.categories.includes("world");
  const nothingSelected = workspace.categories.length === 0;
  const canSubmit = !nothingSelected && !workspace.exportBusy && !running;
  const submitBlockedReason = running
    ? `Stop ${server.displayName} before exporting.`
    : nothingSelected
      ? "Choose at least one thing to include."
      : "";

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
        <h2 id={titleId}>Export {server.displayName}</h2>
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
          The ZIP archive can be imported back into this panel or another one.
        </p>

        {running && (
          <Banner
            tone="warning"
            title="Stop the server before exporting"
            message={`${server.displayName} is running. A world copied while the server is running can contain half-written chunks.`}
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
                {workspace.categories.includes(descriptor.key) && bytes !== undefined
                  ? <ExportSize className="exportCategorySize" bytes={bytes} />
                  : <span className="exportCategorySize" />}
              </label>
            );
          })}
          {nothingSelected && (
            <small id="export-selection-hint" className="exportSelectionHint">Choose at least one thing to include.</small>
          )}
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

        <div className="exportEstimate">
          {workspace.estimating ? (
            <span className="exportEstimateLine"><Spinner /> Measuring selection…</span>
          ) : workspace.estimate ? (
            <span className="exportEstimateLine">
              <strong><ExportSize bytes={workspace.estimate.totalBytes} /></strong> before compression
              {workspace.estimate.availableBytes !== undefined && (
                <> · <ExportSize bytes={workspace.estimate.availableBytes} /> free on the panel</>
              )}
            </span>
          ) : null}
          {worldSelected && (
            <small>Worlds are usually most of the archive. Datapacks are inside the world folder and travel with it.</small>
          )}
        </div>

        {workspace.exportError && <Banner tone="error" title="Export failed" message={workspace.exportError} />}
      </div>

      <footer className="modalFooter">
        <Button variant="secondary" onClick={workspace.closeExport} disabled={workspace.exportBusy}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void workspace.runExport()}
          disabled={!canSubmit}
          title={submitBlockedReason || undefined}
          aria-describedby={nothingSelected ? "export-selection-hint" : undefined}
        >
          {workspace.exportBusy ? "Starting…" : "Export"}
        </Button>
      </footer>
    </DialogSurface>
  );
}
