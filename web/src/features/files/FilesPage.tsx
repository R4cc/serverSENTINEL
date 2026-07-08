import { AppIcon, FileTypeIcon } from "../../components/FileTypeIcon";
import { FileEditorModal } from "../../components/FileEditorModal";
import { InlineState } from "../../components/InlineState";
import { SortHeaderButton } from "../../components/TableControls";
import { Button } from "../../components/UiPrimitives";
import { fileDisplayType, fileStatusLabel, isEditableFile } from "../../utils/files";
import { formatBytes } from "../../utils/format";
import { hasFileManagerPermission, isServerPropertiesPath } from "../../utils/permissions";
import type { PublicUser } from "../../types";
import type { FilesWorkspace } from "./useFilesWorkspace";

type FilesPageProps = {
  workspace: FilesWorkspace;
  activeServerIsDemo: boolean;
  permissionUser: PublicUser | null;
  isProvisioning: boolean;
  dockerOperationalLock: boolean;
  serverRequiresStoppedForMutableConfig: boolean;
  stoppedServerMutationMessage: string;
  dateTimeFormatter: Intl.DateTimeFormat;
};

export function FilesPage({
  workspace,
  activeServerIsDemo,
  permissionUser,
  isProvisioning,
  dockerOperationalLock,
  serverRequiresStoppedForMutableConfig,
  stoppedServerMutationMessage,
  dateTimeFormatter
}: FilesPageProps) {
  const { data, state, refs, table, actions } = workspace;
  const {
    listing,
    selectedEntries,
    selectedEntry,
    selectedTotalSize,
    sortedFileRows,
    selectionSummary,
    fileBreadcrumbs,
    filePreview
  } = data;
  const {
    filesLoading,
    filesError,
    fileBackStack,
    fileForwardStack,
    fileOperationBusy,
    selectedPath,
    editorText,
    savedEditorText,
    dirty,
    fileOpening,
    fileOpenFailed,
    fileReadError,
    fileSaving,
    fileEditMode,
    fileLeaseBusy,
    fileLeaseMessage,
    discardEditorRequest,
    uploadTouchesMutableConfiguration,
    canViewCurrentFiles,
    canUploadToCurrentPath,
    canEditSelectedPath,
    canOpenSelectedFile,
    canDownloadSelectedItems,
    canDuplicateSelectedFile,
    canRenameSelectedItem,
    canDeleteSelectedItems,
    fileActionBlockedReason,
    fileReadActionBlockedReason
  } = state;

  return (
    <section className="tabPage filesPage">
      <section className="filesExplorer">
        <section className="panel filesPanel">
          <div className="fileNavBar">
            <div className="fileNavButtons">
              <Button variant="secondary" iconOnly className="iconOnlyButton" onClick={actions.navigateBackFiles} disabled={isProvisioning || fileBackStack.length === 0} title={fileBackStack.length === 0 ? "No previous folder" : "Back"} aria-label="Back">
                <AppIcon name="chevronLeft" />
              </Button>
              <Button variant="secondary" iconOnly className="iconOnlyButton" onClick={actions.navigateForwardFiles} disabled={isProvisioning || fileForwardStack.length === 0} title={fileForwardStack.length === 0 ? "No forward folder" : "Forward"} aria-label="Forward">
                <AppIcon name="chevronRight" />
              </Button>
              <Button variant="secondary" iconOnly className="iconOnlyButton" onClick={() => void actions.navigateFiles("/")} disabled={isProvisioning || listing.path === "/"} title={listing.path === "/" ? "Already at server root" : "Go to server root"} aria-label="Go to server root">
                <AppIcon name="home" />
              </Button>
            </div>
            <div className="fileBreadcrumbs" aria-label="Current folder">
              {fileBreadcrumbs.map((crumb) => (
                <button key={crumb.path} type="button" onClick={() => void actions.navigateFiles(crumb.path)} className={crumb.path === listing.path ? "active" : ""} title={crumb.path}>
                  {crumb.label}
                </button>
              ))}
            </div>
            <div className="fileToolbar">
              <input ref={refs.fileUploadRef} className="hiddenInput" type="file" onChange={actions.uploadFile} />
              <Button variant="secondary" compact aria-label="Upload file" onClick={() => refs.fileUploadRef.current?.click()} disabled={isProvisioning || dockerOperationalLock || (serverRequiresStoppedForMutableConfig && uploadTouchesMutableConfiguration) || !canUploadToCurrentPath || Boolean(fileOperationBusy)} title={fileActionBlockedReason || (!canUploadToCurrentPath ? "Upload files permission is required for this folder." : "Upload a file to this folder")}>
                <AppIcon name="fileUp" />
                <span className="fileToolbarLabel">Upload</span>
              </Button>
              <Button variant="secondary" compact aria-label="New folder" onClick={actions.createFolder} disabled={isProvisioning || dockerOperationalLock || (serverRequiresStoppedForMutableConfig && uploadTouchesMutableConfiguration) || !canUploadToCurrentPath || Boolean(fileOperationBusy)} title={fileActionBlockedReason || (!canUploadToCurrentPath ? "Upload files permission is required for this folder." : "Create a folder here")}>
                <AppIcon name="folderPlus" />
                <span className="fileToolbarLabel">New folder</span>
              </Button>
              <Button variant="secondary" compact aria-label={filesLoading ? "Refreshing files" : "Refresh files"} onClick={() => void actions.refreshCurrentFiles()} disabled={isProvisioning || filesLoading || !canViewCurrentFiles} title={canViewCurrentFiles ? "Reload this folder" : "View files permission is required for this folder"} reserveLabel={<><AppIcon name="refresh" /><span className="fileToolbarLabel">Refreshing</span></>}>
                <AppIcon name="refresh" />
                <span className="fileToolbarLabel">{filesLoading ? "Refreshing" : "Refresh"}</span>
              </Button>
            </div>
          </div>

          <div className="selectionActionBar" aria-label="File selection actions">
            <span className="selectionSummary">{selectionSummary}</span>
            <div className="selectionActions">
              <Button variant="secondary" compact aria-label="Open selected file" onClick={() => selectedEntry && actions.openFile(selectedEntry.path)} disabled={!canOpenSelectedFile} title={!selectedEntry ? "Select one text file" : selectedEntry.type !== "file" ? "Folders cannot be opened" : !isEditableFile(selectedEntry) ? "Only small text files can be opened" : fileActionBlockedReason || (!hasFileManagerPermission(permissionUser, selectedEntry.path, "view") && !activeServerIsDemo ? "View files permission is required." : "Open selected file read-only")}>
                <AppIcon name="edit" />
                <span className="selectionActionLabel">Open</span>
              </Button>
              <Button variant="secondary" compact aria-label="Download selected items" onClick={actions.downloadSelectedItems} disabled={!canDownloadSelectedItems} title={!selectedEntries.length ? "Select files or folders to download" : fileReadActionBlockedReason || (!selectedEntries.every((entry) => hasFileManagerPermission(permissionUser, entry.path, "download")) && !activeServerIsDemo ? "Download files permission is required for every selected item." : "Download selected items")}>
                <AppIcon name="download" />
                <span className="selectionActionLabel">Download</span>
              </Button>
              <Button variant="secondary" compact aria-label="Duplicate selected file" onClick={actions.duplicateSelectedFile} disabled={!canDuplicateSelectedFile} title={!selectedEntry ? "Select one file to duplicate" : selectedEntry.type === "directory" ? "Directory duplication is not supported" : fileActionBlockedReason || (!hasFileManagerPermission(permissionUser, selectedEntry.path, "duplicate") && !activeServerIsDemo ? "Upload files permission is required to duplicate here." : "Duplicate selected file")}>
                <AppIcon name="copy" />
                <span className="selectionActionLabel">Duplicate</span>
              </Button>
              <Button variant="secondary" compact aria-label="Rename selected item" onClick={actions.renameSelectedFile} disabled={!canRenameSelectedItem} title={!selectedEntry ? "Select one item to rename" : fileActionBlockedReason || (!hasFileManagerPermission(permissionUser, selectedEntry.path, "rename") && !activeServerIsDemo ? "Edit files permission is required to rename this item." : "Rename selected item")}>
                <AppIcon name="rename" />
                <span className="selectionActionLabel">Rename</span>
              </Button>
              <Button variant="critical" compact aria-label="Delete selected items" onClick={actions.deleteSelectedFiles} disabled={!canDeleteSelectedItems} title={!selectedEntries.length ? "Select items to delete" : fileActionBlockedReason || (!selectedEntries.every((entry) => hasFileManagerPermission(permissionUser, entry.path, "delete")) && !activeServerIsDemo ? "Delete files permission is required for every selected item." : "Delete selected items")}>
                <AppIcon name="trash" />
                <span className="selectionActionLabel">Delete</span>
              </Button>
            </div>
          </div>

          {filesLoading && listing.entries.length === 0 && (
            <InlineState tone="loading" title="Loading files" message={`Loading the contents of ${listing.path}.`} />
          )}
          {filesError && (
            <InlineState
              tone="error"
              title="Could not load this folder"
              message={`${filesError} Check that the server files are available, then retry.`}
              actionLabel="Retry"
              onAction={() => void actions.refreshCurrentFiles()}
              busy={filesLoading}
            />
          )}

          <div className="fileTable" role="table" aria-label="Server files">
            <div className="fileTableHead" role="row">
              <label className="fileCheckboxCell fileSelectAllCell" aria-label={table.getIsAllRowsSelected() ? "Clear visible selection" : "Select all visible files"}>
                <input
                  ref={refs.fileSelectAllRef}
                  type="checkbox"
                  checked={table.getIsAllRowsSelected()}
                  disabled={sortedFileRows.length === 0}
                  onChange={table.getToggleAllRowsSelectedHandler()}
                />
              </label>
              {table.getHeaderGroups()[0]?.headers.filter((header) => header.id !== "select").map((header) => (
                <SortHeaderButton key={header.id} header={header}>
                  {header.id === "name" ? "Name" : header.id === "modifiedAt" ? "Date Modified" : header.id === "type" ? "Type" : "Size"}
                </SortHeaderButton>
              ))}
            </div>
            {!filesLoading && !filesError && sortedFileRows.length === 0 && (
              <InlineState tone="empty" title="This folder is empty" message="There are no files or folders here yet. Upload a file or create a folder to add content." />
            )}
            {sortedFileRows.map((row) => {
              const entry = row.original;
              const selected = row.getIsSelected();
              return (
                <div key={entry.path} className={`fileTableRow ${selected ? "selected" : ""}`} role="row" onDoubleClick={() => actions.activateFileEntry(entry)}>
                  <label className="fileCheckboxCell" aria-label={`Select ${entry.name}`}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={row.getToggleSelectedHandler()}
                    />
                  </label>
                  <button type="button" className="fileNameCell" onClick={() => entry.type === "directory" ? actions.navigateFiles(entry.path) : actions.setSelectedFilePaths([entry.path])} title={entry.path}>
                    <FileTypeIcon entry={entry} />
                    <span>{entry.name}</span>
                  </button>
                  <span>{dateTimeFormatter.format(new Date(entry.modifiedAt))}</span>
                  <span>{fileDisplayType(entry)}</span>
                  <span>{entry.type === "file" ? formatBytes(entry.size) : "-"}</span>
                </div>
              );
            })}
          </div>
          <div className="fileTableFooter">
            <span>{sortedFileRows.length} items</span>
            <span>{selectedEntries.length > 0 ? `${selectedEntries.length} selected (${formatBytes(selectedTotalSize)})` : listing.path}</span>
          </div>
        </section>
      </section>

      <aside className="panel fileDetailsPanel">
        {!selectedEntry && selectedEntries.length === 0 && (
          <div className="fileDetailsEmpty">
            <h2>No file selected</h2>
            <p>Select a file or folder from the list to view details. Text files will also show a read-only preview here.</p>
          </div>
        )}
        {selectedEntries.length > 1 && (
          <div className="fileDetailsContent">
            <h2>{selectedEntries.length} items selected</h2>
            <dl>
              <div><dt>Total file size</dt><dd>{formatBytes(selectedTotalSize)}</dd></div>
              <div><dt>Folders</dt><dd>{selectedEntries.filter((entry) => entry.type === "directory").length}</dd></div>
              <div><dt>Files</dt><dd>{selectedEntries.filter((entry) => entry.type === "file").length}</dd></div>
            </dl>
          </div>
        )}
        {selectedEntry && (
          <div className="fileDetailsContent">
            <div className="fileDetailsTitle">
              <FileTypeIcon entry={selectedEntry} />
              <div>
                <h2>{selectedEntry.name}</h2>
                <span>{fileDisplayType(selectedEntry)}</span>
              </div>
            </div>
            <dl>
              <div><dt>Location</dt><dd>{selectedEntry.path}</dd></div>
              <div><dt>Type</dt><dd>{fileDisplayType(selectedEntry)}</dd></div>
              <div><dt>Size</dt><dd>{selectedEntry.type === "file" ? formatBytes(selectedEntry.size) : "-"}</dd></div>
              <div><dt>Modified</dt><dd>{dateTimeFormatter.format(new Date(selectedEntry.modifiedAt))}</dd></div>
              {selectedEntry.permissions && <div><dt>Permissions</dt><dd>{selectedEntry.permissions}</dd></div>}
              {selectedEntry.owner && <div><dt>Owner</dt><dd>{selectedEntry.owner}</dd></div>}
              <div><dt>Status</dt><dd>{fileStatusLabel(selectedEntry)}</dd></div>
            </dl>
            <section className="filePreviewPanel">
              <h3>Preview</h3>
              {filePreview.loading && <InlineState tone="loading" title="Loading preview" message="Reading a small preview of this file." />}
              {filePreview.error && <InlineState tone="error" title="Preview is unavailable" message={`${filePreview.error} You can still download or edit supported text files from the toolbar.`} />}
              {!filePreview.loading && !filePreview.error && filePreview.data?.preview === "text" && (
                <pre>
                  {(filePreview.data.content ?? "").split(/\r?\n/).slice(0, 80).map((line, index) => (
                    <span key={`${index}-${line.slice(0, 8)}`}><b>{index + 1}</b>{line || " "}</span>
                  ))}
                </pre>
              )}
              {!filePreview.loading && !filePreview.error && filePreview.data?.preview !== "text" && (
                <div className="previewUnavailable">
                  <strong>Preview unavailable</strong>
                  <span>{filePreview.data?.message ?? "This item cannot be previewed here. You can still use the available file actions above."}</span>
                </div>
              )}
            </section>
          </div>
        )}
      </aside>

      <FileEditorModal
        selectedPath={selectedPath}
        editorText={editorText}
        dirty={dirty}
        fileOpening={fileOpening}
        fileOpenFailed={fileOpenFailed}
        fileReadError={fileReadError}
        fileSaving={fileSaving}
        editing={fileEditMode}
        editBusy={fileLeaseBusy}
        editMessage={fileLeaseMessage}
        editDisabled={isProvisioning || dockerOperationalLock || (serverRequiresStoppedForMutableConfig && isServerPropertiesPath(selectedPath)) || !canEditSelectedPath || !selectedPath || fileOpenFailed}
        editDisabledReason={serverRequiresStoppedForMutableConfig && isServerPropertiesPath(selectedPath) ? stoppedServerMutationMessage : ""}
        editorDisabled={!fileEditMode || isProvisioning || dockerOperationalLock || (serverRequiresStoppedForMutableConfig && isServerPropertiesPath(selectedPath)) || !canEditSelectedPath || !selectedPath || fileOpenFailed}
        saveDisabled={!fileEditMode || fileSaving || isProvisioning || dockerOperationalLock || (serverRequiresStoppedForMutableConfig && isServerPropertiesPath(selectedPath)) || !canEditSelectedPath || !selectedPath || !dirty || fileOpening || fileOpenFailed}
        discardRequestOpen={Boolean(discardEditorRequest)}
        onTextChange={(nextText) => {
          actions.setEditorText(nextText);
          actions.setDirty(nextText !== savedEditorText);
        }}
        onRequestClose={actions.requestCloseEditor}
        onCancel={actions.cancelFileEdit}
        onSave={actions.saveFile}
        onEnterEdit={actions.enterFileEditMode}
        onRetryOpen={() => {
          if (selectedPath) void actions.openFile(selectedPath, true);
        }}
        onKeepEditing={() => actions.setDiscardEditorRequest(null)}
        onDiscardChanges={actions.discardEditorChanges}
      />
    </section>
  );
}
