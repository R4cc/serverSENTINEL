import { useEffect, useRef, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { AppIcon, FileTypeIcon } from "../../components/FileTypeIcon";
import { FileEditorModal } from "../../components/FileEditorModal";
import { InlineState } from "../../components/InlineState";
import { SortHeaderButton } from "../../components/TableControls";
import { Button } from "../../components/UiPrimitives";
import { fileDisplayType, fileStatusLabel, isEditableFile } from "../../utils/files";
import { formatBytes } from "../../utils/format";
import { hasFileManagerPermission, isServerPropertiesPath } from "../../utils/permissions";
import type { PublicUser } from "../../types";
import type { FileActionDialog, FilesWorkspace } from "./useFilesWorkspace";

type FilesPageProps = {
  workspace: FilesWorkspace;
  activeServerIsDemo: boolean;
  permissionUser: PublicUser | null;
  isProvisioning: boolean;
  dockerOperationalLock: boolean;
  serverRequiresStoppedForMutableConfig: boolean;
  stoppedServerMutationMessage: string;
  dateTimeFormatter: Intl.DateTimeFormat;
  onCopyText: (text: string) => void;
};

export function FilesPage({
  workspace,
  activeServerIsDemo,
  permissionUser,
  isProvisioning,
  dockerOperationalLock,
  serverRequiresStoppedForMutableConfig,
  stoppedServerMutationMessage,
  dateTimeFormatter,
  onCopyText
}: FilesPageProps) {
  const { data, state, refs, table, actions } = workspace;
  const {
    listing,
    archiveContext,
    selectedEntries,
    selectedEntry,
    selectedZipEntry,
    selectedTotalSize,
    sortedFileRows,
    selectionSummary,
    fileBreadcrumbs,
    filePreview,
    zipDestinationListing,
    zipConflictPlan
  } = data;
  const {
    filesLoading,
    filesError,
    fileBackStack,
    fileForwardStack,
    fileOperationBusy,
    focusedFilePath,
    fileActionDialog,
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
    canOpenSelectedZip,
    canExtractSelectedZip,
    canDownloadSelectedItems,
    canDuplicateSelectedFile,
    canRenameSelectedItem,
    canDeleteSelectedItems,
    fileActionBlockedReason,
    fileReadActionBlockedReason,
    zipDestinationLoading,
    zipOperationId
  } = state;
  const breadcrumbRef = useRef<HTMLDivElement>(null);
  const fileTableRef = useRef<HTMLDivElement>(null);
  const rowButtonRefs = useRef(new Map<string, HTMLButtonElement>());
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const previousDialogOpenRef = useRef(false);
  const operationLabel = fileOperationBusy === "upload" ? "Uploading file…"
    : fileOperationBusy === "new-folder" ? "Creating folder…"
      : fileOperationBusy === "rename" ? "Renaming item…"
        : fileOperationBusy === "duplicate" ? "Duplicating file…"
          : fileOperationBusy === "delete" ? "Deleting items…"
            : "";

  useEffect(() => {
    breadcrumbRef.current?.querySelector<HTMLElement>(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [listing.path, archiveContext?.archivePath]);

  useEffect(() => {
    const dialogOpen = Boolean(fileActionDialog);
    if (dialogOpen && !previousDialogOpenRef.current) dialogTriggerRef.current = document.activeElement as HTMLElement | null;
    if (!dialogOpen && previousDialogOpenRef.current) {
      if (dialogTriggerRef.current?.isConnected) dialogTriggerRef.current.focus();
      else fileTableRef.current?.focus();
    }
    previousDialogOpenRef.current = dialogOpen;
  }, [fileActionDialog]);

  function handleRowKeyDown(event: KeyboardEvent<HTMLButtonElement>, entryPath: string) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const nextPath = actions.moveFileFocus(entryPath, event.key === "ArrowDown" ? 1 : -1, event.shiftKey);
      if (nextPath) requestAnimationFrame(() => rowButtonRefs.current.get(nextPath)?.focus());
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const entry = listing.entries.find((candidate) => candidate.path === entryPath);
      if (entry) actions.activateFileEntry(entry);
      return;
    }
    if (event.key === " ") {
      event.preventDefault();
      actions.selectFileEntry(entryPath, { toggle: true });
    }
  }

  function selectFromPointer(event: MouseEvent<HTMLElement>, path: string) {
    actions.selectFileEntry(path, {
      toggle: event.ctrlKey || event.metaKey,
      range: event.shiftKey,
      additive: event.shiftKey && (event.ctrlKey || event.metaKey)
    });
  }

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
              <Button variant="secondary" iconOnly className="iconOnlyButton" onClick={actions.navigateFilesUp} disabled={isProvisioning || (!archiveContext && listing.path === "/")} title={!archiveContext && listing.path === "/" ? "Already at server root" : "Go up one folder"} aria-label="Go up one folder">
                <AppIcon name="arrowUp" />
              </Button>
              <Button variant="secondary" iconOnly className="iconOnlyButton" onClick={() => void actions.navigateFiles("/")} disabled={isProvisioning || (!archiveContext && listing.path === "/")} title={!archiveContext && listing.path === "/" ? "Already at server root" : "Go to server root"} aria-label="Go to server root">
                <AppIcon name="home" />
              </Button>
            </div>
            <div className="fileBreadcrumbs" aria-label="Current folder" ref={breadcrumbRef}>
              {fileBreadcrumbs.map((crumb) => (
                <button key={`${crumb.kind}:${crumb.path}`} type="button" onClick={() => void (crumb.kind === "archive" ? actions.navigateArchive(crumb.path) : actions.navigateFiles(crumb.path))} className={crumb.path === listing.path && ((archiveContext && crumb.kind === "archive") || (!archiveContext && crumb.kind === "filesystem")) ? "active" : ""} title={crumb.kind === "archive" && archiveContext ? `${archiveContext.archivePath}!${crumb.path}` : crumb.path}>
                  {crumb.label}
                </button>
              ))}
            </div>
            <div className="fileToolbar">
              {!archiveContext && <>
                <input ref={refs.fileUploadRef} className="hiddenInput" type="file" onChange={actions.uploadFile} />
                <Button variant="secondary" compact aria-label="Upload file" onClick={() => refs.fileUploadRef.current?.click()} disabled={isProvisioning || dockerOperationalLock || (serverRequiresStoppedForMutableConfig && uploadTouchesMutableConfiguration) || !canUploadToCurrentPath || Boolean(fileOperationBusy) || Boolean(zipOperationId)} title={fileActionBlockedReason || (!canUploadToCurrentPath ? "Upload files permission is required for this folder." : "Upload a file to this folder")}>
                  <AppIcon name="fileUp" />
                  <span className="fileToolbarLabel">Upload</span>
                </Button>
                <Button variant="secondary" compact aria-label="New folder" onClick={actions.openCreateFolderDialog} disabled={isProvisioning || dockerOperationalLock || (serverRequiresStoppedForMutableConfig && uploadTouchesMutableConfiguration) || !canUploadToCurrentPath || Boolean(fileOperationBusy) || Boolean(zipOperationId)} title={fileActionBlockedReason || (!canUploadToCurrentPath ? "Upload files permission is required for this folder." : "Create a folder here")}>
                  <AppIcon name="folderPlus" />
                  <span className="fileToolbarLabel">New folder</span>
                </Button>
              </>}
              <Button variant="secondary" compact aria-label={filesLoading ? "Refreshing files" : "Refresh files"} onClick={() => void actions.refreshCurrentFiles()} disabled={isProvisioning || filesLoading || !canViewCurrentFiles} title={canViewCurrentFiles ? "Reload this folder" : "View files permission is required for this folder"} reserveLabel={<><AppIcon name="refresh" /><span className="fileToolbarLabel">Refreshing</span></>}>
                <AppIcon name="refresh" />
                <span className="fileToolbarLabel">{filesLoading ? "Refreshing" : "Refresh"}</span>
              </Button>
            </div>
          </div>

          {archiveContext && (
            <div className="zipReadOnlyBanner" role="status">
              <AppIcon name="archive" />
              <div><strong>ZIP archive — read only</strong><span>You are viewing {archiveContext.archivePath}. Extract its contents before editing them.</span></div>
            </div>
          )}

          <div className="selectionActionBar" aria-label="File selection actions">
            <span className="selectionSummary" role="status" aria-live="polite">{operationLabel || selectionSummary}</span>
            <div className="selectionActions">
              {selectedZipEntry && <>
                <Button variant="secondary" compact onClick={actions.openSelectedZip} disabled={!canOpenSelectedZip} title="Open this ZIP as a read-only folder"><AppIcon name="archive" /><span className="selectionActionLabel">Open ZIP</span></Button>
                <Button variant="secondary" compact onClick={actions.extractSelectedZipHere} disabled={!canExtractSelectedZip} title="Extract all contents beside the ZIP"><AppIcon name="extract" /><span className="selectionActionLabel">Extract here</span></Button>
                <Button variant="secondary" compact onClick={actions.extractSelectedZipToFolder} disabled={!canExtractSelectedZip} title={`Extract to ${selectedZipEntry.name.replace(/\.zip$/i, "") || "archive"}/`}><AppIcon name="extract" /><span className="selectionActionLabel">Extract to folder</span></Button>
                <Button variant="secondary" compact onClick={actions.openZipDestinationPicker} disabled={!canExtractSelectedZip} title="Choose a server folder"><AppIcon name="folderPlus" /><span className="selectionActionLabel">Extract…</span></Button>
              </>}
              {selectedEntry?.type === "file" && isEditableFile(selectedEntry) && <Button variant="secondary" compact aria-label="Open selected file" onClick={() => actions.openFile(selectedEntry.path)} disabled={!canOpenSelectedFile} title={fileActionBlockedReason || (!hasFileManagerPermission(permissionUser, selectedEntry.path, "view") && !activeServerIsDemo ? "View files permission is required." : "Open selected file read-only")}>
                <AppIcon name="edit" />
                <span className="selectionActionLabel">Open</span>
              </Button>}
              {selectedEntries.length > 0 && <Button variant="secondary" compact aria-label="Download selected items" onClick={actions.downloadSelectedItems} disabled={!canDownloadSelectedItems} title={fileReadActionBlockedReason || (!selectedEntries.every((entry) => hasFileManagerPermission(permissionUser, entry.path, "download")) && !activeServerIsDemo ? "Download files permission is required for every selected item." : "Download selected items")}>
                <AppIcon name="download" />
                <span className="selectionActionLabel">Download</span>
              </Button>}
              {!archiveContext && selectedEntry?.type === "file" && <Button variant="secondary" compact aria-label="Duplicate selected file" onClick={actions.openDuplicateDialog} disabled={!canDuplicateSelectedFile} title={fileActionBlockedReason || (!hasFileManagerPermission(permissionUser, selectedEntry.path, "duplicate") && !activeServerIsDemo ? "Upload files permission is required to duplicate here." : "Duplicate selected file")}>
                <AppIcon name="copy" />
                <span className="selectionActionLabel">Duplicate</span>
              </Button>}
              {!archiveContext && selectedEntry && <Button variant="secondary" compact aria-label="Rename selected item" onClick={actions.openRenameDialog} disabled={!canRenameSelectedItem} title={fileActionBlockedReason || (!hasFileManagerPermission(permissionUser, selectedEntry.path, "rename") && !activeServerIsDemo ? "Edit files permission is required to rename this item." : "Rename selected item")}>
                <AppIcon name="rename" />
                <span className="selectionActionLabel">Rename</span>
              </Button>}
              {!archiveContext && selectedEntries.length > 0 && <Button variant="critical" compact aria-label="Delete selected items" onClick={actions.openDeleteDialog} disabled={!canDeleteSelectedItems} title={fileActionBlockedReason || (!selectedEntries.every((entry) => hasFileManagerPermission(permissionUser, entry.path, "delete")) && !activeServerIsDemo ? "Delete files permission is required for every selected item." : "Delete selected items")}>
                <AppIcon name="trash" />
                <span className="selectionActionLabel">Delete</span>
              </Button>}
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

          <div className="fileTable" role="table" aria-label="Server files" aria-busy={filesLoading || Boolean(fileOperationBusy)} aria-rowcount={sortedFileRows.length + 1} ref={fileTableRef} tabIndex={-1}>
            <div className="fileTableHead" role="row">
              <label className="fileCheckboxCell fileSelectAllCell" role="columnheader" aria-label={table.getIsAllRowsSelected() ? "Clear visible selection" : "Select all visible files"}>
                <input
                  ref={refs.fileSelectAllRef}
                  type="checkbox"
                  checked={table.getIsAllRowsSelected()}
                  disabled={sortedFileRows.length === 0}
                  onChange={table.getToggleAllRowsSelectedHandler()}
                />
              </label>
              {table.getHeaderGroups()[0]?.headers.filter((header) => header.id !== "select").map((header) => (
                <span className={`fileColumnHeader fileColumnHeader--${header.id}`} key={header.id} role="presentation"><SortHeaderButton header={header}>
                  {header.id === "name" ? "Name" : header.id === "modifiedAt" ? "Date Modified" : header.id === "type" ? "Type" : "Size"}
                </SortHeaderButton></span>
              ))}
            </div>
            {!filesLoading && !filesError && sortedFileRows.length === 0 && (
              <InlineState tone="empty" title="This folder is empty" message={archiveContext ? "There are no entries in this ZIP folder." : "There are no files or folders here yet. Upload a file or create a folder to add content."} />
            )}
            {sortedFileRows.map((row) => {
              const entry = row.original;
              const selected = row.getIsSelected();
              return (
                <div
                  key={entry.path}
                  className={`fileTableRow ${selected ? "selected" : ""}`}
                  role="row"
                  aria-selected={selected}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest(".fileCheckboxCell")) return;
                    selectFromPointer(event, entry.path);
                  }}
                  onDoubleClick={(event) => {
                    if ((event.target as HTMLElement).closest(".fileCheckboxCell")) return;
                    actions.activateFileEntry(entry);
                  }}
                >
                  <label className="fileCheckboxCell" role="cell" aria-label={`Select ${entry.name}`}>
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={() => actions.selectFileEntry(entry.path, { toggle: true })}
                    />
                  </label>
                  <button
                    type="button"
                    role="rowheader"
                    className="fileNameCell"
                    ref={(node) => { if (node) rowButtonRefs.current.set(entry.path, node); else rowButtonRefs.current.delete(entry.path); }}
                    tabIndex={focusedFilePath === entry.path || (!focusedFilePath && sortedFileRows[0]?.original.path === entry.path) ? 0 : -1}
                    onFocus={() => actions.setFocusedFilePath(entry.path)}
                    onKeyDown={(event) => handleRowKeyDown(event, entry.path)}
                    title={`${entry.path} — Double-click or press Enter to open`}
                  >
                    <FileTypeIcon entry={entry} />
                    <span>{entry.name}</span>
                  </button>
                  <span className="fileModifiedCell" role="cell">{dateTimeFormatter.format(new Date(entry.modifiedAt))}</span>
                  <span className="fileTypeCell" role="cell">{fileDisplayType(entry)}</span>
                  <span className="fileSizeCell" role="cell">{entry.type === "file" ? formatBytes(entry.size) : "-"}</span>
                </div>
              );
            })}
          </div>
          <div className="fileTableFooter">
            <span>{sortedFileRows.length} items</span>
            <span title={archiveContext ? `${archiveContext.archivePath}!${listing.path}` : listing.path}>{selectedEntries.length > 0 ? `${selectedEntries.length} selected (${formatBytes(selectedTotalSize)})` : archiveContext ? `${archiveContext.archivePath}!${listing.path}` : listing.path}</span>
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
              <div><dt>Location</dt><dd>{archiveContext ? `${archiveContext.archivePath}!${selectedEntry.path}` : selectedEntry.path}</dd></div>
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

      {fileActionDialog && (
        <FileActionModal
          dialog={fileActionDialog}
          busy={Boolean(fileOperationBusy)}
          onValueChange={actions.setFileActionDialogValue}
          onCancel={actions.closeFileActionDialog}
          onSubmit={actions.submitFileActionDialog}
        />
      )}

      {zipDestinationListing && (
        <div className="modalBackdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) actions.setZipDestinationListing(null);
        }}>
          <section className="modalPanel zipDestinationModal" role="dialog" aria-modal="true" aria-labelledby="zip-destination-title">
            <header className="modalHeader">
              <div><h2 id="zip-destination-title">Choose extraction folder</h2><p>Extract into {zipDestinationListing.path}</p></div>
              <Button iconOnly variant="secondary" onClick={() => actions.setZipDestinationListing(null)} aria-label="Close destination picker"><AppIcon name="x" /></Button>
            </header>
            <div className="modalBody zipDestinationBody">
              <div className="zipDestinationPath">{zipDestinationListing.path}</div>
              {zipDestinationListing.path !== "/" && <button type="button" className="zipFolderChoice" onClick={() => actions.loadZipDestination(zipDestinationListing.path.split("/").slice(0, -1).join("/") || "/")}><AppIcon name="arrowUp" /> Parent folder</button>}
              {zipDestinationListing.entries.filter((entry) => entry.type === "directory").map((entry) => (
                <button type="button" className="zipFolderChoice" key={entry.path} onClick={() => actions.loadZipDestination(entry.path)}><FileTypeIcon entry={entry} /> {entry.name}</button>
              ))}
              {!zipDestinationLoading && !zipDestinationListing.entries.some((entry) => entry.type === "directory") && <p className="muted">This folder has no subfolders.</p>}
            </div>
            <footer className="modalFooter">
              <Button variant="secondary" onClick={() => actions.setZipDestinationListing(null)}>Cancel</Button>
              <Button onClick={actions.confirmZipDestination} disabled={zipDestinationLoading}>{zipDestinationLoading ? "Loading" : "Extract here"}</Button>
            </footer>
          </section>
        </div>
      )}

      {zipConflictPlan && (
        <div className="modalBackdrop" role="presentation">
          <section className="modalPanel zipConflictModal" role="dialog" aria-modal="true" aria-labelledby="zip-conflict-title">
            <header className="modalHeader"><h2 id="zip-conflict-title">Files already exist</h2></header>
            <div className="modalBody">
              <p>{zipConflictPlan.conflicts.length} file{zipConflictPlan.conflicts.length === 1 ? "" : "s"} already exist in {zipConflictPlan.destinationPath}.</p>
              <ul>{zipConflictPlan.conflicts.slice(0, 5).map((conflict) => <li key={conflict.path}>{conflict.path}</li>)}</ul>
              {zipConflictPlan.conflicts.length > 5 && <p>…and {zipConflictPlan.conflicts.length - 5} more.</p>}
            </div>
            <footer className="modalFooter zipConflictActions">
              <Button variant="secondary" onClick={() => actions.setZipConflictPlan(null)}>Cancel</Button>
              <Button variant="secondary" onClick={() => actions.startZipExtraction(zipConflictPlan, "skip")}>Skip all</Button>
              <Button onClick={() => actions.startZipExtraction(zipConflictPlan, "replace")}>Replace all</Button>
            </footer>
          </section>
        </div>
      )}

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
        editDisabled={Boolean(archiveContext) || isProvisioning || dockerOperationalLock || (serverRequiresStoppedForMutableConfig && isServerPropertiesPath(selectedPath)) || !canEditSelectedPath || !selectedPath || fileOpenFailed}
        editDisabledReason={archiveContext ? "ZIP archive contents are read-only. Extract this file before editing it." : serverRequiresStoppedForMutableConfig && isServerPropertiesPath(selectedPath) ? stoppedServerMutationMessage : ""}
        readOnlyOnly={Boolean(archiveContext)}
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
        onCopy={() => onCopyText(editorText)}
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

export function FileActionModal({
  dialog,
  busy,
  onValueChange,
  onCancel,
  onSubmit
}: {
  dialog: FileActionDialog;
  busy: boolean;
  onValueChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const modalRef = useRef<HTMLElement>(null);
  const title = dialog.kind === "create" ? "Create a new folder"
    : dialog.kind === "rename" ? `Rename ${dialog.entry.name}`
      : dialog.kind === "duplicate" ? `Duplicate ${dialog.entry.name}`
        : dialog.entries.length === 1 ? `Delete ${dialog.entries[0].name}?` : `Delete ${dialog.entries.length} items?`;
  const submitLabel = dialog.kind === "create" ? "Create folder"
    : dialog.kind === "rename" ? "Rename"
      : dialog.kind === "duplicate" ? "Duplicate"
        : dialog.entries.length === 1 ? "Delete item" : `Delete ${dialog.entries.length} items`;
  const busyLabel = dialog.kind === "create" ? "Creating…"
    : dialog.kind === "rename" ? "Renaming…"
      : dialog.kind === "duplicate" ? "Duplicating…"
        : "Deleting…";

  useEffect(() => {
    if (dialog.kind === "delete") modalRef.current?.focus();
  }, [dialog.kind]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel]);

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSubmit();
  }

  const error = dialog.error;
  const folders = dialog.kind === "delete" ? dialog.entries.filter((entry) => entry.type === "directory").length : 0;
  const files = dialog.kind === "delete" ? dialog.entries.length - folders : 0;

  return (
    <div className="modalBackdrop fileActionBackdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section className="modalPanel fileActionModal" role="dialog" aria-modal="true" aria-labelledby="file-action-title" aria-describedby="file-action-description" tabIndex={-1} ref={modalRef}>
        <form onSubmit={handleSubmit}>
          <header className="modalHeader">
            <div>
              <h2 id="file-action-title">{title}</h2>
              <p id="file-action-description">
                {dialog.kind === "create" ? "Add a folder to the current location."
                  : dialog.kind === "rename" ? "Choose a new name for this item."
                    : dialog.kind === "duplicate" ? "Choose a name for the copied file."
                      : "Review the affected items before continuing."}
              </p>
            </div>
            <Button iconOnly variant="secondary" onClick={onCancel} disabled={busy} aria-label="Close file action dialog"><AppIcon name="x" /></Button>
          </header>
          <div className="modalBody fileActionBody">
            {dialog.kind !== "delete" ? (
              <label className="fileNameField">
                <span>{dialog.kind === "create" ? "Folder name" : "Name"}</span>
                <input autoFocus value={dialog.value} onChange={(event) => onValueChange(event.target.value)} disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? "file-action-error" : undefined} />
              </label>
            ) : (
              <>
                <div className="deleteSummary" aria-label="Items to delete">
                  <span><strong>{files}</strong> {files === 1 ? "file" : "files"}</span>
                  <span><strong>{folders}</strong> {folders === 1 ? "folder" : "folders"}</span>
                </div>
                <ul className="deletePathList">
                  {dialog.entries.slice(0, 6).map((entry) => <li key={entry.path}>{entry.path}</li>)}
                  {dialog.entries.length > 6 && <li>…and {dialog.entries.length - 6} more</li>}
                </ul>
                {folders > 0 && <p className="fileActionWarning">Selected folders and everything inside them will be deleted.</p>}
                <p className="fileActionDanger">This action cannot be undone.</p>
              </>
            )}
            {error && <p className="fileActionError" id="file-action-error" role="alert">{error}</p>}
          </div>
          <footer className="modalFooter">
            <Button variant="secondary" onClick={onCancel} disabled={busy}>Cancel</Button>
            <Button variant={dialog.kind === "delete" ? "critical" : "primary"} type="submit" disabled={busy || (dialog.kind !== "delete" && !dialog.value.trim())} reserveLabel={busyLabel}>{busy ? busyLabel : submitLabel}</Button>
          </footer>
        </form>
      </section>
    </div>
  );
}
