import { useId } from "react";
import { AppIcon } from "../../components/FileTypeIcon";
import { Banner, Button, FormField } from "../../components/UiPrimitives";
import { DialogSurface } from "../../components/DialogSurface";
import { formatBytes } from "../../utils/format";
import type { ContextNode } from "../../types";
import type { ExportWorkspace } from "./useExportWorkspace";

export function ImportModal({
  workspace,
  nodes,
  onImported
}: {
  workspace: ExportWorkspace;
  nodes: ContextNode[];
  onImported: () => void | Promise<void>;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const fileId = useId();
  const nodeId = useId();
  const validation = workspace.importValidation;
  const canApply = Boolean(validation?.valid) && !workspace.importBusy;

  return (
    <DialogSurface
      backdrop
      className="modalPanel exportModalPanel"
      labelledBy={titleId}
      describedBy={descriptionId}
      onClose={workspace.closeImport}
      dismissible={!workspace.importBusy}
    >
      <header className="modalHeader">
        <h2 id={titleId}>Import servers</h2>
        <Button
          variant="secondary"
          iconOnly
          className="iconButton modalCloseButton"
          onClick={workspace.closeImport}
          disabled={workspace.importBusy}
          aria-label="Close import dialog"
          title="Close dialog"
        >
          <AppIcon name="x" />
        </Button>
      </header>

      <div className="modalBody exportModalBody">
        <p id={descriptionId} className="uiFormFieldDescription">
          Restore an export archive. Every server in the archive is created as a new server; nothing
          existing is overwritten.
        </p>

        <FormField label="Export archive" htmlFor={fileId} required>
          <input
            id={fileId}
            type="file"
            accept=".zip,application/zip"
            disabled={workspace.importBusy}
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              workspace.setImportFile(file);
              if (file) void workspace.uploadAndValidate(file, workspace.importTargetNodeId);
            }}
          />
        </FormField>

        <FormField
          label="Target node"
          htmlFor={nodeId}
          description="Imports are restored onto the panel's own node. Move the server to another node afterwards."
        >
          <select
            id={nodeId}
            value={workspace.importTargetNodeId}
            disabled={workspace.importBusy}
            onChange={(event) => {
              workspace.setImportTargetNodeId(event.target.value);
              if (workspace.importFile) void workspace.uploadAndValidate(workspace.importFile, event.target.value);
            }}
          >
            {nodes.map((node) => (
              <option key={node.id} value={node.id}>{node.name}</option>
            ))}
          </select>
        </FormField>

        {workspace.importTask && (
          <div className="exportProgress" role="status">
            <progress value={workspace.importProgress} max={100} />
            <span>{workspace.importTask}</span>
          </div>
        )}

        {validation && (
          <div className="importPlan">
            <h3>This archive contains</h3>
            <ul>
              {validation.plan.servers.map((server) => (
                <li key={server.newId}>
                  <strong>{server.displayName}</strong>
                  <span>
                    {server.fileCount} file(s) · {formatBytes(server.totalBytes)}
                    {server.lockfileCount > 0 && ` · ${server.lockfileCount} mod/plugin re-download(s)`}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {validation?.issues.length ? (
          <Banner
            tone="error"
            title="This archive cannot be imported yet"
            message={validation.issues.map((issue) => issue.message).join(" ")}
          />
        ) : null}

        {validation?.warnings.length ? (
          <Banner
            tone="info"
            title="Before you import"
            message={validation.warnings.map((warning) => warning.message).join(" ")}
          />
        ) : null}

        {workspace.importError && <Banner tone="error" title="Import failed" message={workspace.importError} />}
      </div>

      <footer className="modalFooter">
        <Button variant="secondary" onClick={workspace.closeImport} disabled={workspace.importBusy}>Cancel</Button>
        <Button variant="primary" onClick={() => void workspace.runImport(onImported)} disabled={!canApply}>
          {workspace.importBusy ? "Importing…" : "Import"}
        </Button>
      </footer>
    </DialogSurface>
  );
}
