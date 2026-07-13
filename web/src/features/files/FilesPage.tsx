import { useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent, type MouseEvent } from "react";
import { AppIcon, FileTypeIcon } from "../../components/FileTypeIcon";
import { FileEditorModal } from "../../components/FileEditorModal";
import { InlineState } from "../../components/InlineState";
import { SortHeaderButton } from "../../components/TableControls";
import { Button, LoadingLabel, SkeletonBlock } from "../../components/UiPrimitives";
import { ActionMenu, type ActionMenuItem } from "../../components/ActionMenu";
import { ContextMenu } from "../../components/ContextMenu";
import { DialogSurface } from "../../components/DialogSurface";
import { fileDisplayType, fileStatusLabel, isEditableFile } from "../../utils/files";
import { formatBytes } from "../../utils/format";
import { hasFileManagerPermission } from "../../utils/permissions";
import type { PublicUser } from "../../types";
import type { FileActionDialog, FilesWorkspace } from "./useFilesWorkspace";
import { fileContextSelectionIntent, fileEntryPointerIntent } from "./fileSelection";

type FileContextMenuState = {
  invocationId: number;
  kind: "selection" | "background";
  x: number;
  y: number;
  returnFocus: HTMLElement | null;
};

type FilesPageProps = {
  workspace: FilesWorkspace;
  activeServerIsDemo: boolean;
  permissionUser: PublicUser | null;
  isProvisioning: boolean;
  dockerOperationalLock: boolean;
  dateTimeFormatter: Intl.DateTimeFormat;
  onCopyText: (text: string) => void;
};

export function FilesPage({
  workspace,
  activeServerIsDemo,
  permissionUser,
  isProvisioning,
  dockerOperationalLock,
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
  const contextMenuInvocationRef = useRef(0);
  const draggedFilePathRef = useRef("");
  const dialogTriggerRef = useRef<HTMLElement | null>(null);
  const previousDialogOpenRef = useRef(false);
  const [fileContextMenu, setFileContextMenu] = useState<FileContextMenuState | null>(null);
  const [draggedFilePath, setDraggedFilePath] = useState("");
  const [fileDropTargetPath, setFileDropTargetPath] = useState("");
  const initialFilesLoading = filesLoading && listing.entries.length === 0;
  const operationLabel = fileOperationBusy === "upload" ? "Uploading file…"
    : fileOperationBusy === "new-folder" ? "Creating folder…"
      : fileOperationBusy === "rename" ? "Renaming item…"
        : fileOperationBusy === "move" ? "Moving item…"
        : fileOperationBusy === "duplicate" ? "Duplicating file…"
          : fileOperationBusy === "delete" ? "Deleting items…"
            : "";

  useEffect(() => {
    breadcrumbRef.current?.querySelector<HTMLElement>(".active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
    setFileContextMenu(null);
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
    if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      openEntryContextMenu(
        entryPath,
        Math.min(bounds.left + 48, bounds.right - 8),
        Math.min(bounds.top + 28, bounds.bottom - 4),
        event.currentTarget
      );
      return;
    }
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

  function openContextMenu(next: Omit<FileContextMenuState, "invocationId">) {
    contextMenuInvocationRef.current += 1;
    setFileContextMenu({ ...next, invocationId: contextMenuInvocationRef.current });
  }

  function applyContextMenuSelection(path?: string) {
    const intent = fileContextSelectionIntent(selectedEntries.map((entry) => entry.path), path);
    if (intent === "clear") actions.clearFileSelection();
    else if (intent === "replace" && path) actions.selectFileEntry(path);
    else if (path) actions.setFocusedFilePath(path);
  }

  function openEntryContextMenu(path: string, x: number, y: number, returnFocus: HTMLElement | null) {
    applyContextMenuSelection(path);
    openContextMenu({ kind: "selection", x, y, returnFocus });
  }

  function handleEntryContextMenu(event: MouseEvent<HTMLDivElement>, path: string) {
    event.preventDefault();
    event.stopPropagation();
    openEntryContextMenu(path, event.clientX, event.clientY, rowButtonRefs.current.get(path) ?? event.currentTarget);
  }

  function handleFileTableContextMenu(event: MouseEvent<HTMLDivElement>) {
    const target = event.target as HTMLElement;
    if (target.closest(".fileTableHead, .fileTableRow")) return;
    event.preventDefault();
    applyContextMenuSelection();
    openContextMenu({ kind: "background", x: event.clientX, y: event.clientY, returnFocus: fileTableRef.current });
  }

  function draggedEntry() {
    return listing.entries.find((entry) => entry.path === draggedFilePathRef.current);
  }

  function clearFileDrag() {
    draggedFilePathRef.current = "";
    setDraggedFilePath("");
    setFileDropTargetPath("");
  }

  function handleFileDragStart(event: DragEvent<HTMLDivElement>, entry: (typeof listing.entries)[number]) {
    if ((event.target as HTMLElement).closest("input") || !actions.canDragFileEntry(entry)) {
      event.preventDefault();
      return;
    }
    actions.selectFileEntry(entry.path);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/x-serversentinel-file", entry.path);
    draggedFilePathRef.current = entry.path;
    setDraggedFilePath(entry.path);
  }

  function handleFileDragOver(event: DragEvent<HTMLElement>, destinationPath: string) {
    const entry = draggedEntry();
    if (!entry || !actions.canMoveFileEntry(entry, destinationPath)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    if (fileDropTargetPath !== destinationPath) setFileDropTargetPath(destinationPath);
  }

  function handleFileDragLeave(event: DragEvent<HTMLElement>, destinationPath: string) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    if (fileDropTargetPath === destinationPath) setFileDropTargetPath("");
  }

  function handleFileDrop(event: DragEvent<HTMLElement>, destinationPath: string) {
    const entry = draggedEntry();
    if (!entry || !actions.canMoveFileEntry(entry, destinationPath)) return;
    event.preventDefault();
    clearFileDrag();
    void actions.moveFileEntry(entry, destinationPath);
  }

  const secondarySelectionActions: ActionMenuItem[] = [];
  if (selectedZipEntry) {
    secondarySelectionActions.push(
      { id: "extract-here", label: "Extract here", icon: <AppIcon name="extract" />, onSelect: actions.extractSelectedZipHere, disabled: !canExtractSelectedZip, title: "Extract all contents beside the ZIP" },
      { id: "extract-folder", label: "Extract to folder", icon: <AppIcon name="extract" />, onSelect: actions.extractSelectedZipToFolder, disabled: !canExtractSelectedZip, title: `Extract to ${selectedZipEntry.name.replace(/\.zip$/i, "") || "archive"}/` },
      { id: "extract-choose", label: "Choose extract folder", icon: <AppIcon name="folderPlus" />, onSelect: actions.openZipDestinationPicker, disabled: !canExtractSelectedZip, title: "Choose a server folder" }
    );
  }
  if (!archiveContext && selectedEntry?.type === "file") {
    secondarySelectionActions.push({ id: "duplicate", label: "Duplicate", icon: <AppIcon name="copy" />, onSelect: actions.openDuplicateDialog, disabled: !canDuplicateSelectedFile, title: fileActionBlockedReason || "Duplicate selected file" });
  }
  if (!archiveContext && selectedEntry) {
    secondarySelectionActions.push({ id: "rename", label: "Rename", icon: <AppIcon name="rename" />, onSelect: actions.openRenameDialog, disabled: !canRenameSelectedItem, title: fileActionBlockedReason || "Rename selected item" });
  }
  if (!archiveContext && selectedEntries.length > 0) {
    secondarySelectionActions.push({ id: "delete", label: "Delete", icon: <AppIcon name="trash" />, onSelect: actions.openDeleteDialog, disabled: !canDeleteSelectedItems, critical: true, title: fileActionBlockedReason || "Delete selected items" });
  }

  const selectionContextActions: ActionMenuItem[] = [];
  if (selectedEntry?.type === "directory") {
    const permissionPath = archiveContext?.archivePath ?? selectedEntry.path;
    const canOpenFolder = !isProvisioning
      && !dockerOperationalLock
      && !filesLoading
      && (activeServerIsDemo || hasFileManagerPermission(permissionUser, permissionPath, "view"));
    selectionContextActions.push({
      id: "open-folder",
      label: "Open",
      icon: <AppIcon name="chevronRight" />,
      onSelect: () => actions.activateFileEntry(selectedEntry),
      disabled: !canOpenFolder,
      title: fileReadActionBlockedReason || (canOpenFolder ? "Open folder" : "View files permission is required.")
    });
  } else if (selectedZipEntry) {
    selectionContextActions.push({ id: "open-zip", label: "Open ZIP", icon: <AppIcon name="archive" />, onSelect: actions.openSelectedZip, disabled: !canOpenSelectedZip, title: "Open this ZIP as a read-only folder" });
  } else if (selectedEntry?.type === "file" && isEditableFile(selectedEntry)) {
    selectionContextActions.push({
      id: "open-file",
      label: "Open",
      icon: <AppIcon name="edit" />,
      onSelect: () => actions.openFile(selectedEntry.path),
      disabled: !canOpenSelectedFile,
      title: fileActionBlockedReason || "Open selected file read-only"
    });
  }
  if (selectedEntries.length > 0) {
    selectionContextActions.push({
      id: "download",
      label: "Download",
      icon: <AppIcon name="download" />,
      onSelect: actions.downloadSelectedItems,
      disabled: !canDownloadSelectedItems,
      separatorBefore: selectionContextActions.length > 0,
      title: fileReadActionBlockedReason || "Download selected items"
    });
  }
  const extractionActions = secondarySelectionActions.filter((item) => item.id.startsWith("extract-"));
  const mutationActions = secondarySelectionActions.filter((item) => !item.id.startsWith("extract-"));
  extractionActions.forEach((item, index) => selectionContextActions.push({
    ...item,
    separatorBefore: index === 0 && selectionContextActions.length > 0
  }));
  mutationActions.forEach((item, index) => selectionContextActions.push({
    ...item,
    separatorBefore: index === 0 && selectionContextActions.length > 0
  }));

  const backgroundContextActions: ActionMenuItem[] = [];
  if (!archiveContext) {
    backgroundContextActions.push(
      {
        id: "upload",
        label: "Upload file",
        icon: <AppIcon name="fileUp" />,
        onSelect: () => refs.fileUploadRef.current?.click(),
        disabled: isProvisioning || dockerOperationalLock || !canUploadToCurrentPath || Boolean(fileOperationBusy) || Boolean(zipOperationId),
        title: fileActionBlockedReason || "Upload a file to this folder"
      },
      {
        id: "new-folder",
        label: "New folder",
        icon: <AppIcon name="folderPlus" />,
        onSelect: actions.openCreateFolderDialog,
        disabled: isProvisioning || dockerOperationalLock || !canUploadToCurrentPath || Boolean(fileOperationBusy) || Boolean(zipOperationId),
        title: fileActionBlockedReason || "Create a folder here"
      }
    );
  }
  backgroundContextActions.push({
    id: "refresh",
    label: filesLoading ? "Refreshing" : "Refresh",
    icon: <AppIcon name="refresh" />,
    onSelect: () => void actions.refreshCurrentFiles(),
    disabled: isProvisioning || filesLoading || !canViewCurrentFiles,
    separatorBefore: backgroundContextActions.length > 0,
    title: canViewCurrentFiles ? "Reload this folder" : "View files permission is required for this folder"
  });

  return (
    <section className="tabPage filesPage layoutWide">
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
                <button
                  key={`${crumb.kind}:${crumb.path}`}
                  type="button"
                  onClick={() => void (crumb.kind === "archive" ? actions.navigateArchive(crumb.path) : actions.navigateFiles(crumb.path))}
                  className={`${crumb.path === listing.path && ((archiveContext && crumb.kind === "archive") || (!archiveContext && crumb.kind === "filesystem")) ? "active" : ""} ${crumb.kind === "filesystem" && fileDropTargetPath === crumb.path ? "fileDropTarget" : ""}`.trim()}
                  title={crumb.kind === "archive" && archiveContext ? `${archiveContext.archivePath}!${crumb.path}` : draggedFilePath && crumb.kind === "filesystem" ? `Move to ${crumb.path}` : crumb.path}
                  onDragOver={crumb.kind === "filesystem" ? (event) => handleFileDragOver(event, crumb.path) : undefined}
                  onDragLeave={crumb.kind === "filesystem" ? (event) => handleFileDragLeave(event, crumb.path) : undefined}
                  onDrop={crumb.kind === "filesystem" ? (event) => handleFileDrop(event, crumb.path) : undefined}
                >
                  {crumb.label}
                </button>
              ))}
            </div>
            <div className="fileToolbar">
              {!archiveContext && <>
                <input ref={refs.fileUploadRef} className="hiddenInput" type="file" onChange={actions.uploadFile} />
                <Button variant="secondary" compact aria-label="Upload file" onClick={() => refs.fileUploadRef.current?.click()} disabled={isProvisioning || dockerOperationalLock || !canUploadToCurrentPath || Boolean(fileOperationBusy) || Boolean(zipOperationId)} title={fileActionBlockedReason || (!canUploadToCurrentPath ? "Upload files permission is required for this folder." : "Upload a file to this folder")}>
                  <AppIcon name="fileUp" />
                  <span className="fileToolbarLabel">Upload</span>
                </Button>
                <Button variant="secondary" compact aria-label="New folder" onClick={actions.openCreateFolderDialog} disabled={isProvisioning || dockerOperationalLock || !canUploadToCurrentPath || Boolean(fileOperationBusy) || Boolean(zipOperationId)} title={fileActionBlockedReason || (!canUploadToCurrentPath ? "Upload files permission is required for this folder." : "Create a folder here")}>
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

          <section className="fileListSurface" aria-label="File list">
          <div className="selectionActionBar" aria-label="File selection actions">
            <span className="selectionSummary" role="status" aria-live="polite">{operationLabel || selectionSummary}</span>
            <div className="selectionActions">
              {selectedZipEntry && <>
                <Button variant="secondary" compact onClick={actions.openSelectedZip} disabled={!canOpenSelectedZip} title="Open this ZIP as a read-only folder"><AppIcon name="archive" /><span className="selectionActionLabel">Open ZIP</span></Button>
              </>}
              {selectedEntry?.type === "file" && isEditableFile(selectedEntry) && <Button variant="secondary" compact aria-label="Open selected file" onClick={() => actions.openFile(selectedEntry.path)} disabled={!canOpenSelectedFile} title={fileActionBlockedReason || (!hasFileManagerPermission(permissionUser, selectedEntry.path, "view") && !activeServerIsDemo ? "View files permission is required." : "Open selected file read-only")}>
                <AppIcon name="edit" />
                <span className="selectionActionLabel">Open</span>
              </Button>}
              {selectedEntries.length > 0 && <Button variant="secondary" compact aria-label="Download selected items" onClick={actions.downloadSelectedItems} disabled={!canDownloadSelectedItems} title={fileReadActionBlockedReason || (!selectedEntries.every((entry) => hasFileManagerPermission(permissionUser, entry.path, "download")) && !activeServerIsDemo ? "Download files permission is required for every selected item." : "Download selected items")}>
                <AppIcon name="download" />
                <span className="selectionActionLabel">Download</span>
              </Button>}
              {secondarySelectionActions.length > 0 && <ActionMenu
                label="More file actions"
                className="selectionActionMenu"
                items={secondarySelectionActions}
                trigger={<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>}
              />}
            </div>
          </div>

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

          <div className="fileTable" role="table" aria-label="Server files" aria-busy={filesLoading || Boolean(fileOperationBusy)} aria-rowcount={(initialFilesLoading ? 8 : sortedFileRows.length) + 1} ref={fileTableRef} tabIndex={-1} onContextMenu={handleFileTableContextMenu}>
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
            {initialFilesLoading && <LoadingLabel>Loading files in {listing.path}</LoadingLabel>}
            {initialFilesLoading && Array.from({ length: 8 }, (_, index) => <FileTableSkeletonRow key={index} />)}
            {!filesLoading && !filesError && sortedFileRows.length === 0 && (
              <InlineState tone="empty" title="This folder is empty" message={archiveContext ? "There are no entries in this ZIP folder." : "There are no files or folders here yet. Upload a file or create a folder to add content."} />
            )}
            {sortedFileRows.map((row) => {
              const entry = row.original;
              const selected = row.getIsSelected();
              return (
                <div
                  key={entry.path}
                  className={`fileTableRow ${selected ? "selected" : ""} ${draggedFilePath === entry.path ? "fileDragging" : ""} ${entry.type === "directory" && fileDropTargetPath === entry.path ? "fileDropTarget" : ""}`.trim()}
                  role="row"
                  aria-selected={selected}
                  draggable={actions.canDragFileEntry(entry)}
                  onDragStart={(event) => handleFileDragStart(event, entry)}
                  onDragEnd={clearFileDrag}
                  onDragOver={entry.type === "directory" ? (event) => handleFileDragOver(event, entry.path) : undefined}
                  onDragLeave={entry.type === "directory" ? (event) => handleFileDragLeave(event, entry.path) : undefined}
                  onDrop={entry.type === "directory" ? (event) => handleFileDrop(event, entry.path) : undefined}
                  onContextMenu={(event) => handleEntryContextMenu(event, entry.path)}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest(".fileCheckboxCell")) return;
                    if (fileEntryPointerIntent("click").select) selectFromPointer(event, entry.path);
                  }}
                  onDoubleClick={(event) => {
                    if ((event.target as HTMLElement).closest(".fileCheckboxCell")) return;
                    if (fileEntryPointerIntent("double-click").activate) actions.activateFileEntry(entry);
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
                    onClick={(event) => {
                      event.stopPropagation();
                      selectFromPointer(event, entry.path);
                    }}
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
            <span>{initialFilesLoading ? <SkeletonBlock className="fileFooterCountSkeleton" /> : `${sortedFileRows.length} items`}</span>
            <span title={archiveContext ? `${archiveContext.archivePath}!${listing.path}` : listing.path}>{initialFilesLoading ? <SkeletonBlock className="fileFooterPathSkeleton" /> : selectedEntries.length > 0 ? `${selectedEntries.length} selected (${formatBytes(selectedTotalSize)})` : archiveContext ? `${archiveContext.archivePath}!${listing.path}` : listing.path}</span>
          </div>
          </section>
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
              {filePreview.loading && <FilePreviewSkeleton />}
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

      {fileContextMenu && (
        <ContextMenu
          key={fileContextMenu.invocationId}
          label={fileContextMenu.kind === "selection" ? "File actions" : "Folder actions"}
          items={fileContextMenu.kind === "selection" ? selectionContextActions : backgroundContextActions}
          x={fileContextMenu.x}
          y={fileContextMenu.y}
          returnFocus={fileContextMenu.returnFocus}
          onClose={() => setFileContextMenu(null)}
        />
      )}

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
          <DialogSurface className="modalPanel zipDestinationModal" labelledBy="zip-destination-title" onClose={() => actions.setZipDestinationListing(null)}>
            <header className="modalHeader">
              <div><h2 id="zip-destination-title">Choose extraction folder</h2><p>Extract into {zipDestinationListing.path}</p></div>
              <Button iconOnly variant="secondary" onClick={() => actions.setZipDestinationListing(null)} aria-label="Close destination picker"><AppIcon name="x" /></Button>
            </header>
            <div className="modalBody zipDestinationBody">
              <div className="zipDestinationPath">{zipDestinationListing.path}</div>
              {zipDestinationListing.path !== "/" && <button type="button" className="zipFolderChoice" onClick={() => actions.loadZipDestination(zipDestinationListing.path.split("/").slice(0, -1).join("/") || "/")}><AppIcon name="arrowUp" /> Parent folder</button>}
              {zipDestinationLoading && <LoadingLabel>Loading extraction folders</LoadingLabel>}
              {zipDestinationLoading && Array.from({ length: 4 }, (_, index) => <div className="zipFolderChoice zipFolderSkeleton" key={index} aria-hidden="true"><SkeletonBlock className="uiSkeleton--icon" /><SkeletonBlock className="uiSkeleton--text" /></div>)}
              {zipDestinationListing.entries.filter((entry) => entry.type === "directory").map((entry) => (
                <button type="button" className="zipFolderChoice" key={entry.path} onClick={() => actions.loadZipDestination(entry.path)}><FileTypeIcon entry={entry} /> {entry.name}</button>
              ))}
              {!zipDestinationLoading && !zipDestinationListing.entries.some((entry) => entry.type === "directory") && <p className="muted">This folder has no subfolders.</p>}
            </div>
            <footer className="modalFooter">
              <Button variant="secondary" onClick={() => actions.setZipDestinationListing(null)}>Cancel</Button>
              <Button onClick={actions.confirmZipDestination} disabled={zipDestinationLoading}>{zipDestinationLoading ? "Loading" : "Extract here"}</Button>
            </footer>
          </DialogSurface>
        </div>
      )}

      {zipConflictPlan && (
        <div className="modalBackdrop" role="presentation">
          <DialogSurface className="modalPanel zipConflictModal" labelledBy="zip-conflict-title" onClose={() => actions.setZipConflictPlan(null)}>
            <header className="modalHeader"><h2 id="zip-conflict-title">Files already exist</h2></header>
            <div className="modalBody">
              <p>{zipConflictPlan.conflicts.length} file{zipConflictPlan.conflicts.length === 1 ? "" : "s"} already exist in {zipConflictPlan.destinationPath}.</p>
              <ul>{zipConflictPlan.conflicts.slice(0, 5).map((conflict) => <li key={conflict.path}>{conflict.path}</li>)}</ul>
              {zipConflictPlan.conflicts.length > 5 && <p>…and {zipConflictPlan.conflicts.length - 5} more.</p>}
            </div>
            <footer className="modalFooter zipConflictActions">
              <Button variant="secondary" onClick={() => actions.setZipConflictPlan(null)}>Cancel</Button>
              <Button variant="secondary" onClick={() => actions.startZipExtraction(zipConflictPlan, "skip")}>Skip all</Button>
              <Button variant="critical" onClick={() => actions.startZipExtraction(zipConflictPlan, "replace")}>Replace all</Button>
            </footer>
          </DialogSurface>
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
        editDisabled={Boolean(archiveContext) || isProvisioning || dockerOperationalLock || !canEditSelectedPath || !selectedPath || fileOpenFailed}
        editDisabledReason={archiveContext ? "ZIP archive contents are read-only. Extract this file before editing it." : ""}
        readOnlyOnly={Boolean(archiveContext)}
        editorDisabled={!fileEditMode || isProvisioning || dockerOperationalLock || !canEditSelectedPath || !selectedPath || fileOpenFailed}
        saveDisabled={!fileEditMode || fileSaving || isProvisioning || dockerOperationalLock || !canEditSelectedPath || !selectedPath || !dirty || fileOpening || fileOpenFailed}
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

function FileTableSkeletonRow() {
  return (
    <div className="fileTableRow fileTableSkeletonRow" role="row" aria-hidden="true">
      <span className="fileCheckboxCell"><SkeletonBlock className="fileCheckboxSkeleton" /></span>
      <div className="fileNameCell"><SkeletonBlock className="uiSkeleton--icon" /><SkeletonBlock className="fileNameSkeleton" /></div>
      <span className="fileModifiedCell"><SkeletonBlock className="uiSkeleton--text" /></span>
      <span className="fileTypeCell"><SkeletonBlock className="uiSkeleton--text" /></span>
      <span className="fileSizeCell"><SkeletonBlock className="fileSizeSkeleton" /></span>
    </div>
  );
}

function FilePreviewSkeleton() {
  return (
    <div className="filePreviewSkeleton" aria-busy="true">
      <LoadingLabel>Loading file preview</LoadingLabel>
      {Array.from({ length: 10 }, (_, index) => (
        <SkeletonBlock key={index} className="filePreviewLineSkeleton" style={{ width: `${58 + (index * 17) % 38}%` }} />
      ))}
    </div>
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
      <DialogSurface className="modalPanel fileActionModal" labelledBy="file-action-title" describedBy="file-action-description" onClose={() => { if (!busy) onCancel(); }}>
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
      </DialogSurface>
    </div>
  );
}
