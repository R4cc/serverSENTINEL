import { type ChangeEvent, type MutableRefObject, useEffect, useMemo, useRef, useState } from "react";
import {
  functionalUpdate,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type RowSelectionState,
  type SortingState
} from "@tanstack/react-table";
import { ApiError, api, apiErrorFromResponse } from "../../api";
import { demoListing, demoServerId } from "../../demo";
import type { FileEditLease, FileEntry, FileListing, FilePreview, InstalledMod, ManagedServer, PublicUser } from "../../types";
import type { FilePreviewState } from "../../app/uiState";
import { demoRequestHeaders } from "../../app/appConfig";
import { bufferToBase64, fileDisplayType, isEditableFile, isPreviewableFile, joinPublicPath, parentPath } from "../../utils/files";
import { hasFileManagerPermission, isModsPublicPath, isServerPropertiesPath } from "../../utils/permissions";
import { validateSafePath } from "../../utils/validation";
import { clearDeletedFileState, defaultDuplicateName, errorMessage, fileNameValidation, publicPathContains } from "../../utils/appHelpers";
import { formatBytes } from "../../utils/format";

type DownloadIntent =
  | {
      mode: "individual";
      totalSize: number;
      files: Array<{ name: string; path: string; size: number; url: string }>;
    }
  | {
      mode: "archive";
      totalSize: number;
      filename: string;
      url: string;
      expiresAt: string;
    };

type NotifyFn = (type: "success" | "error" | "info" | "warning", text: string) => void;

type UseFilesWorkspaceOptions = {
  activeServer: ManagedServer | null | undefined;
  activeServerIsDemo: boolean;
  activeServerIdRef: MutableRefObject<string>;
  demoMode: boolean;
  demoFiles: Record<string, string>;
  setDemoFiles: (updater: Record<string, string> | ((current: Record<string, string>) => Record<string, string>)) => void;
  demoInstalledMods: InstalledMod[];
  setDemoInstalledMods: (updater: InstalledMod[] | ((current: InstalledMod[]) => InstalledMod[])) => void;
  isProvisioning: boolean;
  dockerOperationalLock: boolean;
  runtimeControlsDisabledReason: string;
  serverRequiresStoppedForMutableConfig: boolean;
  stoppedServerMutationMessage: string;
  permissionUser: PublicUser | null;
  formatDisplayDate: (value: string | number | Date) => string;
  notify: NotifyFn;
  setNotice: (message: string) => void;
  handleStaleSession: (error: unknown) => boolean;
  refreshModsAfterFilesChange: () => Promise<unknown> | unknown;
};

export function useFilesWorkspace({
  activeServer,
  activeServerIsDemo,
  activeServerIdRef,
  demoMode,
  demoFiles,
  setDemoFiles,
  demoInstalledMods,
  setDemoInstalledMods,
  isProvisioning,
  dockerOperationalLock,
  runtimeControlsDisabledReason,
  serverRequiresStoppedForMutableConfig,
  stoppedServerMutationMessage,
  permissionUser,
  formatDisplayDate,
  notify,
  setNotice,
  handleStaleSession,
  refreshModsAfterFilesChange
}: UseFilesWorkspaceOptions) {
  const [listing, setListing] = useState<FileListing>({ path: "/", entries: [] });
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  const [fileBackStack, setFileBackStack] = useState<string[]>([]);
  const [fileForwardStack, setFileForwardStack] = useState<string[]>([]);
  const [fileSorting, setFileSorting] = useState<SortingState>([{ id: "name", desc: false }]);
  const [filePreview, setFilePreview] = useState<FilePreviewState>({ path: "", loading: false, data: null, error: "" });
  const [fileOperationBusy, setFileOperationBusy] = useState("");
  const [selectedPath, setSelectedPath] = useState("");
  const [editorText, setEditorText] = useState("");
  const [savedEditorText, setSavedEditorText] = useState("");
  const [fileRevision, setFileRevision] = useState("");
  const [fileEditLease, setFileEditLease] = useState<FileEditLease | null>(null);
  const [fileEditMode, setFileEditMode] = useState(false);
  const [fileLeaseBusy, setFileLeaseBusy] = useState(false);
  const [fileLeaseMessage, setFileLeaseMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [fileReadError, setFileReadError] = useState("");
  const [fileOpenFailed, setFileOpenFailed] = useState(false);
  const [fileOpening, setFileOpening] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [discardEditorRequest, setDiscardEditorRequest] = useState<{ action: "close" } | { action: "switch"; path: string } | null>(null);
  const fileUploadRef = useRef<HTMLInputElement>(null);
  const fileSelectAllRef = useRef<HTMLInputElement>(null);
  const fileEditLeaseRef = useRef<FileEditLease | null>(null);

  const canViewCurrentFiles = activeServerIsDemo || hasFileManagerPermission(permissionUser, listing.path, "view");
  const canUploadToCurrentPath = activeServerIsDemo || hasFileManagerPermission(permissionUser, listing.path, "upload");
  const canEditSelectedPath = activeServerIsDemo || (selectedPath ? hasFileManagerPermission(permissionUser, selectedPath, "edit") : false);

  const selectedEntries = useMemo(() => {
    const selected = new Set(selectedFilePaths);
    return listing.entries.filter((entry) => selected.has(entry.path));
  }, [listing.entries, selectedFilePaths]);
  const selectedEntry = selectedEntries.length === 1 ? selectedEntries[0] : null;
  const selectedTotalSize = selectedEntries.reduce((total, entry) => total + (entry.type === "file" ? entry.size : 0), 0);
  const selectedTouchesMutableConfiguration = selectedEntries.some((entry) => isModsPublicPath(entry.path) || isServerPropertiesPath(entry.path));
  const selectedEntryTouchesMutableConfiguration = Boolean(selectedEntry && (isModsPublicPath(selectedEntry.path) || isServerPropertiesPath(selectedEntry.path)));
  const uploadTouchesMutableConfiguration = isModsPublicPath(listing.path);
  const fileRowSelection = useMemo<RowSelectionState>(() => (
    Object.fromEntries(selectedFilePaths.map((path) => [path, true]))
  ), [selectedFilePaths]);
  const fileColumns = useMemo<ColumnDef<FileEntry>[]>(() => {
    const sortedColumn = fileSorting.find((sort) => sort.id !== "select")?.id;
    const fileSortWithFolders = (columnId: string, compare: (left: FileEntry, right: FileEntry) => number) => (left: { original: FileEntry }, right: { original: FileEntry }) => {
      const folderOrder = Number(right.original.type === "directory") - Number(left.original.type === "directory");
      if (folderOrder !== 0) return sortedColumn === columnId && fileSorting[0]?.desc ? -folderOrder : folderOrder;
      const result = compare(left.original, right.original);
      return result === 0 ? left.original.name.localeCompare(right.original.name) : result;
    };

    return [
      { id: "select", enableSorting: false },
      {
        id: "name",
        accessorKey: "name",
        sortingFn: fileSortWithFolders("name", (left, right) => left.name.localeCompare(right.name))
      },
      {
        id: "modifiedAt",
        accessorKey: "modifiedAt",
        sortingFn: fileSortWithFolders("modifiedAt", (left, right) => new Date(left.modifiedAt).getTime() - new Date(right.modifiedAt).getTime())
      },
      {
        id: "type",
        accessorFn: (entry) => fileDisplayType(entry),
        sortingFn: fileSortWithFolders("type", (left, right) => fileDisplayType(left).localeCompare(fileDisplayType(right)))
      },
      {
        id: "size",
        accessorKey: "size",
        sortingFn: fileSortWithFolders("size", (left, right) => left.size - right.size)
      }
    ];
  }, [fileSorting]);
  const fileTable = useReactTable({
    data: listing.entries,
    columns: fileColumns,
    getRowId: (entry) => entry.path,
    state: {
      sorting: fileSorting,
      rowSelection: fileRowSelection
    },
    enableRowSelection: true,
    onSortingChange: setFileSorting,
    onRowSelectionChange: (updater) => {
      setSelectedFilePaths((current) => {
        const currentSelection = Object.fromEntries(current.map((path) => [path, true]));
        const nextSelection = functionalUpdate(updater, currentSelection);
        return Object.keys(nextSelection).filter((path) => nextSelection[path]);
      });
    },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel()
  });
  const sortedFileRows = fileTable.getRowModel().rows;
  const selectionSummary = selectedEntries.length === 0
    ? "No selection"
    : `${selectedEntries.length} ${selectedEntries.length === 1 ? "item" : "items"} selected${selectedTotalSize > 0 ? ` - ${formatBytes(selectedTotalSize)}` : ""}`;
  const fileRuntimeLocked = isProvisioning || dockerOperationalLock;
  const canOpenSelectedFile = Boolean(selectedEntry && selectedEntry.type === "file" && isEditableFile(selectedEntry) && (activeServerIsDemo || hasFileManagerPermission(permissionUser, selectedEntry.path, "view")) && !fileRuntimeLocked);
  const canDownloadSelectedItems = Boolean(selectedEntries.length > 0 && selectedEntries.every((entry) => activeServerIsDemo || hasFileManagerPermission(permissionUser, entry.path, "download")) && !fileRuntimeLocked && !fileOperationBusy);
  const canDuplicateSelectedFile = Boolean(selectedEntry && selectedEntry.type === "file" && (activeServerIsDemo || hasFileManagerPermission(permissionUser, selectedEntry.path, "duplicate")) && !fileRuntimeLocked && !fileOperationBusy && !(serverRequiresStoppedForMutableConfig && selectedEntryTouchesMutableConfiguration));
  const canRenameSelectedItem = Boolean(selectedEntry && (activeServerIsDemo || hasFileManagerPermission(permissionUser, selectedEntry.path, "rename")) && !fileRuntimeLocked && !fileOperationBusy && !(serverRequiresStoppedForMutableConfig && selectedEntryTouchesMutableConfiguration));
  const canDeleteSelectedItems = Boolean(selectedEntries.length > 0 && selectedEntries.every((entry) => activeServerIsDemo || hasFileManagerPermission(permissionUser, entry.path, "delete")) && !fileRuntimeLocked && !fileOperationBusy && !(serverRequiresStoppedForMutableConfig && selectedTouchesMutableConfiguration));
  const fileActionBlockedReason = isProvisioning
    ? "Server setup is still running."
    : dockerOperationalLock
      ? runtimeControlsDisabledReason || "Server files are unavailable until the runtime reconnects."
      : serverRequiresStoppedForMutableConfig && (uploadTouchesMutableConfiguration || selectedTouchesMutableConfiguration)
        ? stoppedServerMutationMessage
      : fileOperationBusy
        ? "A file operation is already running."
        : "";
  const fileReadActionBlockedReason = isProvisioning
    ? "Server setup is still running."
    : dockerOperationalLock
      ? runtimeControlsDisabledReason || "Server files are unavailable until the runtime reconnects."
      : fileOperationBusy
        ? "A file operation is already running."
        : "";
  const fileBreadcrumbs = useMemo(() => {
    const parts = listing.path.split("/").filter(Boolean);
    return [
      { label: "/", path: "/" },
      ...parts.map((part, index) => ({ label: part, path: `/${parts.slice(0, index + 1).join("/")}` }))
    ];
  }, [listing.path]);

  useEffect(() => {
    if (fileSelectAllRef.current) {
      fileSelectAllRef.current.indeterminate = fileTable.getIsSomeRowsSelected() && !fileTable.getIsAllRowsSelected();
    }
  }, [fileRowSelection, fileTable, sortedFileRows.length]);

  useEffect(() => {
    if (!selectedEntry) {
      setFilePreview({ path: "", loading: false, data: null, error: "" });
      return;
    }
    if (selectedEntry.type === "directory") {
      setFilePreview({
        path: selectedEntry.path,
        loading: false,
        data: { path: selectedEntry.path, preview: "unsupported", message: "Preview unavailable" },
        error: ""
      });
      return;
    }
    void loadFilePreview(selectedEntry);
  }, [selectedEntry?.path, selectedEntry?.modifiedAt, selectedEntry?.size, activeServer?.id, demoFiles]);

  useEffect(() => {
    fileEditLeaseRef.current = fileEditLease;
  }, [fileEditLease]);

  useEffect(() => {
    if (!fileEditLease || !fileEditMode || activeServerIsDemo) return;
    const heartbeat = async () => {
      try {
        const result = await api<{ lease: FileEditLease }>(
          `/api/servers/${encodeURIComponent(fileEditLease.serverId)}/file/lease/${encodeURIComponent(fileEditLease.leaseId)}/heartbeat`,
          { method: "POST" }
        );
        setFileEditLease(result.lease);
      } catch (error) {
        const message = error instanceof ApiError && error.code === "FILE_EDIT_LEASE_LOST"
          ? "Your edit lease expired or was lost. Your text is preserved read-only; reload the file before editing again."
          : "The edit lease could not be refreshed. Editing was stopped to protect this file.";
        releaseFileLease(fileEditLease);
        setFileEditMode(false);
        setFileEditLease(null);
        setFileLeaseMessage(message);
        notify("error", message);
      }
    };
    const interval = window.setInterval(() => void heartbeat(), 20_000);
    return () => window.clearInterval(interval);
  }, [fileEditLease?.leaseId, fileEditMode, activeServerIsDemo]);

  useEffect(() => {
    const releaseOnUnload = () => {
      const lease = fileEditLeaseRef.current;
      if (!lease) return;
      void fetch(`/api/servers/${encodeURIComponent(lease.serverId)}/file/lease/${encodeURIComponent(lease.leaseId)}`, {
        method: "DELETE",
        headers: { "X-Requested-With": "XMLHttpRequest" },
        credentials: "same-origin",
        keepalive: true
      });
    };
    window.addEventListener("beforeunload", releaseOnUnload);
    return () => {
      window.removeEventListener("beforeunload", releaseOnUnload);
      releaseOnUnload();
    };
  }, []);

  async function loadFiles(serverId: string, path: string, historyMode: "replace" | "push" | "back" | "forward" = "replace") {
    if (isProvisioning) return false;
    if (!activeServerIsDemo && !hasFileManagerPermission(permissionUser, path, "view")) {
      const message = "View files permission is required for this folder.";
      setFilesError(message);
      setNotice(message);
      return false;
    }
    const previousPath = listing.path;
    setFilesLoading(true);
    setFilesError("");
    setNotice("");
    if (demoMode && serverId === demoServerId) {
      if (activeServerIdRef.current === serverId) {
        const nextListing = demoListing(path, demoFiles, demoInstalledMods);
        setListing(nextListing);
        setSelectedFilePaths([]);
        setFilePreview({ path: "", loading: false, data: null, error: "" });
        if (historyMode === "push" && nextListing.path !== previousPath) {
          setFileBackStack((current) => [...current, previousPath].slice(-50));
          setFileForwardStack([]);
        }
      }
      setFilesLoading(false);
      return true;
    }
    try {
      const nextListing = await api<FileListing>(`/api/servers/${serverId}/files?path=${encodeURIComponent(path)}`);
      if (activeServerIdRef.current === serverId) {
        setListing(nextListing);
        setSelectedFilePaths([]);
        setFilePreview({ path: "", loading: false, data: null, error: "" });
        setFilesError("");
        if (historyMode === "push" && nextListing.path !== previousPath) {
          setFileBackStack((current) => [...current, previousPath].slice(-50));
          setFileForwardStack([]);
        }
      }
      return true;
    } catch (error) {
      if (handleStaleSession(error)) return false;
      const message = errorMessage(error, "Could not load server files. Check that the server path is available.");
      setFilesError(message);
      setNotice(message);
      notify("error", message);
      return false;
    } finally {
      if (activeServerIdRef.current === serverId) setFilesLoading(false);
    }
  }

  async function navigateFiles(path: string) {
    if (!activeServer) return;
    await loadFiles(activeServer.id, path, "push");
  }

  async function refreshCurrentFiles() {
    if (!activeServer) return;
    await loadFiles(activeServer.id, listing.path);
  }

  async function navigateBackFiles() {
    if (!activeServer || fileBackStack.length === 0) return;
    const target = fileBackStack[fileBackStack.length - 1];
    const loaded = await loadFiles(activeServer.id, target, "back");
    if (loaded) {
      setFileBackStack((current) => current.slice(0, -1));
      setFileForwardStack((current) => [listing.path, ...current].slice(0, 50));
    }
  }

  async function navigateForwardFiles() {
    if (!activeServer || fileForwardStack.length === 0) return;
    const target = fileForwardStack[0];
    const loaded = await loadFiles(activeServer.id, target, "forward");
    if (loaded) {
      setFileForwardStack((current) => current.slice(1));
      setFileBackStack((current) => [...current, listing.path].slice(-50));
    }
  }

  function releaseFileLease(lease = fileEditLease) {
    if (!lease || activeServerIsDemo) return;
    void api(`/api/servers/${encodeURIComponent(lease.serverId)}/file/lease/${encodeURIComponent(lease.leaseId)}`, {
      method: "DELETE"
    }).catch(() => undefined);
  }

  function resetEditorState() {
    releaseFileLease();
    setSelectedPath("");
    setEditorText("");
    setSavedEditorText("");
    setFileRevision("");
    setFileEditLease(null);
    setFileEditMode(false);
    setFileLeaseBusy(false);
    setFileLeaseMessage("");
    setDirty(false);
    setFileReadError("");
    setFileOpenFailed(false);
    setFileOpening(false);
    setFileSaving(false);
  }

  function closeEditor() {
    resetEditorState();
    setDiscardEditorRequest(null);
  }

  function requestCloseEditor() {
    if (dirty) {
      setDiscardEditorRequest({ action: "close" });
      return;
    }
    closeEditor();
  }

  function discardEditorChanges() {
    const request = discardEditorRequest;
    setDiscardEditorRequest(null);
    if (!request) return;
    if (request.action === "close") {
      closeEditor();
      return;
    }
    resetEditorState();
    void openFile(request.path, true);
  }

  function unsupportedEditorMessage(entry: FileEntry) {
    if (entry.type !== "file") return "Folders cannot be edited in the browser editor.";
    if (entry.size > 2 * 1024 * 1024) return "Only files up to 2 MiB can be edited in the browser editor.";
    return "Only small text files can be edited in the browser editor.";
  }

  function activateFileEntry(entry: FileEntry) {
    if (entry.type === "directory") {
      void navigateFiles(entry.path);
      return;
    }
    if (!isEditableFile(entry)) {
      const message = unsupportedEditorMessage(entry);
      setSelectedFilePaths([entry.path]);
      setNotice(message);
      notify("warning", message);
      return;
    }
    void openFile(entry.path);
  }

  async function loadFilePreview(entry: FileEntry) {
    if (!activeServer) return;
    setFilePreview({ path: entry.path, loading: true, data: null, error: "" });
    if (!activeServerIsDemo && !hasFileManagerPermission(permissionUser, entry.path, "view")) {
      setFilePreview((current) => current.path === entry.path
        ? { path: entry.path, loading: false, data: null, error: "View files permission is required to preview this file." }
        : current);
      return;
    }
    if (activeServerIsDemo) {
      const content = demoFiles[entry.path] ?? "";
      if (!isPreviewableFile(entry)) {
        setFilePreview((current) => current.path === entry.path
          ? { path: entry.path, loading: false, data: { path: entry.path, preview: "unsupported", message: "Preview unavailable" }, error: "" }
          : current);
      } else if (new Blob([content]).size > 96 * 1024) {
        setFilePreview((current) => current.path === entry.path
          ? { path: entry.path, loading: false, data: { path: entry.path, preview: "too_large", message: "File too large to preview" }, error: "" }
          : current);
      } else {
        setFilePreview((current) => current.path === entry.path
          ? { path: entry.path, loading: false, data: { path: entry.path, preview: "text", content }, error: "" }
          : current);
      }
      return;
    }
    try {
      const preview = await api<FilePreview>(`/api/servers/${activeServer.id}/file/preview?path=${encodeURIComponent(entry.path)}`);
      setFilePreview((current) => current.path === entry.path
        ? { path: entry.path, loading: false, data: preview, error: "" }
        : current);
    } catch (error) {
      setFilePreview((current) => current.path === entry.path
        ? { path: entry.path, loading: false, data: null, error: errorMessage(error, "Could not load a preview for this file.") }
        : current);
    }
  }

  async function openFile(path: string, discardConfirmed = false) {
    if (isProvisioning) return;
    if (!activeServer) return;
    if (dockerOperationalLock) {
      const message = dockerOperationalLock
        ? runtimeControlsDisabledReason || "Server files are unavailable until the runtime reconnects."
        : "Server files are unavailable.";
      setNotice(message);
      notify("warning", message);
      return;
    }
    if (!activeServerIsDemo && !hasFileManagerPermission(permissionUser, path, "view")) {
      const message = "View files permission is required to open this file.";
      setFileReadError(message);
      setNotice(message);
      notify("warning", message);
      return;
    }
    if (selectedPath && selectedPath !== path && dirty && !discardConfirmed) {
      setDiscardEditorRequest({ action: "switch", path });
      return;
    }
    const pathError = validateSafePath(path);
    if (pathError) {
      setFileReadError(pathError);
      setNotice(pathError);
      return;
    }
    const targetEntry = listing.entries.find((entry) => entry.path === path);
    if (targetEntry && !isEditableFile(targetEntry)) {
      const message = unsupportedEditorMessage(targetEntry);
      setSelectedFilePaths([path]);
      setNotice(message);
      notify("warning", message);
      return;
    }
    if (fileEditLease && selectedPath !== path) releaseFileLease(fileEditLease);
    setSelectedPath(path);
    setEditorText("");
    setSavedEditorText("");
    setDirty(false);
    setFileRevision("");
    setFileEditLease(null);
    setFileEditMode(false);
    setFileLeaseMessage("");
    setFileReadError("");
    setFileOpenFailed(false);
    setFileOpening(true);
    setNotice("");
    setSelectedFilePaths([path]);
    if (activeServerIsDemo) {
      const content = demoFiles[path] ?? `Demo binary or generated file: ${path}`;
      setSelectedPath(path);
      setEditorText(content);
      setSavedEditorText(content);
      setFileRevision("demo");
      setDirty(false);
      setFileOpening(false);
      return;
    }
    try {
      const file = await api<{ path: string; content: string; revision: string }>(
        `/api/servers/${activeServer.id}/file?path=${encodeURIComponent(path)}`
      );
      setSelectedPath(file.path);
      setEditorText(file.content);
      setSavedEditorText(file.content);
      setFileRevision(file.revision);
      setDirty(false);
      setSelectedFilePaths([file.path]);
    } catch (error) {
      const message = errorMessage(error, "Could not read this file. Check that the path is available and editable.");
      setFileReadError(message);
      setFileOpenFailed(true);
      setSelectedFilePaths([]);
      notify("error", message);
    } finally {
      setFileOpening(false);
    }
  }

  function leaseConflictMessage(error: unknown) {
    if (!(error instanceof ApiError) || error.code !== "FILE_EDIT_LEASE_CONFLICT") {
      return errorMessage(error, "Could not acquire an edit lease for this file.");
    }
    const details = error.details as { lease?: FileEditLease } | undefined;
    if (details?.lease) {
      return `${details.lease.displayName || "Another user"} is editing this file (last active ${formatDisplayDate(details.lease.refreshedAt)}).`;
    }
    return error.message;
  }

  async function enterFileEditMode() {
    if (!activeServer || !selectedPath || !fileRevision || fileLeaseBusy || fileOpening || fileOpenFailed) return;
    if (serverRequiresStoppedForMutableConfig && isServerPropertiesPath(selectedPath)) {
      setFileLeaseMessage(stoppedServerMutationMessage);
      notify("warning", stoppedServerMutationMessage);
      return;
    }
    if (!canEditSelectedPath) {
      const message = "Edit permission is required to modify this file.";
      setFileLeaseMessage(message);
      notify("warning", message);
      return;
    }
    if (activeServerIsDemo) {
      setFileEditMode(true);
      setFileLeaseMessage("");
      return;
    }
    setFileLeaseBusy(true);
    setFileLeaseMessage("");
    try {
      const result = await api<{ lease: FileEditLease }>(`/api/servers/${activeServer.id}/file/lease`, {
        method: "POST",
        body: JSON.stringify({ path: selectedPath, revision: fileRevision })
      });
      setFileEditLease(result.lease);
      setFileEditMode(true);
    } catch (error) {
      const message = error instanceof ApiError && error.code === "FILE_REVISION_CONFLICT"
        ? "This file changed since it was opened. Reload it before entering edit mode."
        : leaseConflictMessage(error);
      setFileLeaseMessage(message);
      notify("warning", message);
    } finally {
      setFileLeaseBusy(false);
    }
  }

  async function deleteSelectedFiles() {
    if (!activeServer || selectedEntries.length === 0 || fileOperationBusy) return;
    if (isProvisioning || dockerOperationalLock || !canDeleteSelectedItems) return;
    const invalidPath = selectedEntries.map((entry) => validateSafePath(entry.path)).find(Boolean);
    if (invalidPath) {
      setNotice(invalidPath);
      notify("error", invalidPath);
      return;
    }
    const directoryCount = selectedEntries.filter((entry) => entry.type === "directory").length;
    const fileCount = selectedEntries.length - directoryCount;
    const itemLabel = selectedEntries.length === 1 ? selectedEntries[0].name : `${selectedEntries.length} selected items`;
    const previewList = selectedEntries.slice(0, 5).map((entry) => `- ${entry.path}`).join("\n");
    const moreText = selectedEntries.length > 5 ? `\n- ...and ${selectedEntries.length - 5} more` : "";
    const directoryWarning = directoryCount ? "\n\nSelected folders and their contents will be deleted." : "";
    if (!window.confirm(`Delete ${itemLabel}?\n\nFiles: ${fileCount}\nFolders: ${directoryCount}\n${previewList}${moreText}${directoryWarning}\n\nThis cannot be undone.`)) return;

    setFileOperationBusy("delete");
    setNotice("");
    try {
      if (activeServerIsDemo) {
        const deletedEntries = [...selectedEntries];
        const nextFiles = { ...demoFiles };
        for (const entry of deletedEntries) {
          for (const path of Object.keys(nextFiles)) {
            if (publicPathContains(entry.path, path)) delete nextFiles[path];
          }
        }
        const deletedModPaths = new Set(deletedEntries.filter((entry) => entry.path.startsWith("/mods/")).map((entry) => entry.path));
        const nextMods = demoInstalledMods.filter((mod) => !deletedModPaths.has(`/mods/${mod.filename}`));
        setDemoFiles(nextFiles);
        setDemoInstalledMods(nextMods);
        setListing(demoListing(listing.path, nextFiles, nextMods));
        clearDeletedFileState(deletedEntries, selectedPath, filePreview.path, resetEditorState, setFilePreview);
        setSelectedFilePaths([]);
        notify("success", selectedEntries.length === 1 ? `Deleted ${selectedEntries[0].name}` : `Deleted ${selectedEntries.length} items`);
        return;
      }

      const failures: string[] = [];
      const deletedEntries: FileEntry[] = [];
      const deleteTargets = selectedEntries.filter((entry) => !selectedEntries.some((candidate) => (
        candidate.path !== entry.path
        && candidate.type === "directory"
        && publicPathContains(candidate.path, entry.path)
      )));
      for (const entry of deleteTargets) {
        try {
          const recursive = entry.type === "directory" ? "&recursive=true" : "";
          await api(`/api/servers/${activeServer.id}/file?path=${encodeURIComponent(entry.path)}${recursive}`, {
            method: "DELETE"
          });
          deletedEntries.push(entry);
        } catch (error) {
          failures.push(`${entry.name}: ${errorMessage(error, "Delete failed")}`);
        }
      }
      if (deletedEntries.length) {
        clearDeletedFileState(deletedEntries, selectedPath, filePreview.path, resetEditorState, setFilePreview);
        setSelectedFilePaths((current) => current.filter((path) => !deletedEntries.some((entry) => publicPathContains(entry.path, path))));
        notify("success", deletedEntries.length === 1 ? `Deleted ${deletedEntries[0].name}` : `Deleted ${deletedEntries.length} items`);
      }
      await loadFiles(activeServer.id, listing.path);
      await refreshModsAfterFilesChange();
      if (failures.length) {
        const message = `Could not delete ${failures.length} item${failures.length === 1 ? "" : "s"}: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "; ..." : ""}`;
        setNotice(message);
        notify("error", message);
      }
    } finally {
      setFileOperationBusy("");
    }
  }

  async function createFolder() {
    if (!activeServer || fileOperationBusy) return;
    if (fileRuntimeLocked || !canUploadToCurrentPath || (serverRequiresStoppedForMutableConfig && uploadTouchesMutableConfiguration)) return;
    const name = window.prompt("New folder name");
    if (name === null) return;
    const nameError = fileNameValidation(name);
    if (nameError) {
      notify("error", nameError);
      return;
    }
    setFileOperationBusy("new-folder");
    try {
      if (activeServerIsDemo) {
        const folderPath = joinPublicPath(listing.path, name.trim());
        const nextFiles = { ...demoFiles, [joinPublicPath(folderPath, ".serversentinel-folder")]: "" };
        setDemoFiles(nextFiles);
        setListing(demoListing(listing.path, nextFiles, demoInstalledMods));
      } else {
        await api(`/api/servers/${activeServer.id}/folder`, {
          method: "POST",
          body: JSON.stringify({ path: listing.path, name: name.trim() })
        });
        await loadFiles(activeServer.id, listing.path);
      }
      notify("success", `Created ${name.trim()}`);
    } catch (error) {
      notify("error", errorMessage(error, "Could not create the folder."));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function uploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !activeServer || fileOperationBusy) return;
    if (fileRuntimeLocked || !canUploadToCurrentPath || (serverRequiresStoppedForMutableConfig && uploadTouchesMutableConfiguration)) return;
    const nameError = fileNameValidation(file.name);
    if (nameError) {
      notify("error", nameError);
      return;
    }
    if (file.size > 32 * 1024 * 1024) {
      notify("error", "Upload is larger than the 32 MiB file manager limit.");
      return;
    }
    setFileOperationBusy("upload");
    try {
      const targetPath = joinPublicPath(listing.path, file.name);
      if (activeServerIsDemo) {
        const content = await file.text();
        const nextFiles = { ...demoFiles, [targetPath]: content };
        setDemoFiles(nextFiles);
        setListing(demoListing(listing.path, nextFiles, demoInstalledMods));
      } else {
        const contentBase64 = bufferToBase64(await file.arrayBuffer());
        await api(`/api/servers/${activeServer.id}/files/upload`, {
          method: "POST",
          body: JSON.stringify({ path: listing.path, filename: file.name, contentBase64 })
        });
        await loadFiles(activeServer.id, listing.path);
      }
      setSelectedFilePaths([targetPath]);
      notify("success", `Uploaded ${file.name}`);
    } catch (error) {
      notify("error", errorMessage(error, "Could not upload the file."));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function downloadUrl(url: string, filename: string) {
    const response = await fetch(url, {
      headers: {
        "X-Requested-With": "XMLHttpRequest",
        ...(demoMode ? demoRequestHeaders() : {})
      },
      credentials: "same-origin"
    });
    if (!response.ok) {
      throw await apiErrorFromResponse(response);
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(objectUrl);
  }

  async function downloadSelectedItems() {
    if (!activeServer || selectedEntries.length === 0) return;
    if (!canDownloadSelectedItems) return;
    setFileOperationBusy("download");
    try {
      if (activeServerIsDemo) {
        const selectedFiles = selectedEntries.filter((entry) => entry.type === "file");
        const content = selectedFiles.length === 1
          ? demoFiles[selectedFiles[0].path] ?? ""
          : selectedFiles.map((entry) => `# ${entry.path}\n${demoFiles[entry.path] ?? ""}`).join("\n\n");
        const filename = selectedFiles.length === 1 ? selectedFiles[0].name : "demo-selection.txt";
        const blob = new Blob([content], { type: "application/octet-stream" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(url);
      } else {
        const intent = await api<DownloadIntent>(`/api/servers/${activeServer.id}/files/download/intent`, {
          method: "POST",
          body: JSON.stringify({
            paths: selectedEntries.map((entry) => entry.path)
          })
        });
        if (intent.mode === "archive") {
          await downloadUrl(intent.url, intent.filename);
        } else {
          for (const file of intent.files) {
            await downloadUrl(file.url, file.name);
          }
        }
      }
    } catch (error) {
      notify("error", errorMessage(error, "Could not download the selected items."));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function renameSelectedFile() {
    if (!activeServer || selectedEntries.length !== 1 || fileOperationBusy) return;
    if (!canRenameSelectedItem) return;
    const entry = selectedEntries[0];
    if (dirty && selectedPath && publicPathContains(entry.path, selectedPath)) {
      const message = "Save or discard the open editor changes before renaming this item.";
      setNotice(message);
      notify("warning", message);
      return;
    }
    const name = window.prompt("Rename item", entry.name);
    if (name === null || name.trim() === entry.name) return;
    const nameError = fileNameValidation(name);
    if (nameError) {
      notify("error", nameError);
      return;
    }
    setFileOperationBusy("rename");
    try {
      const targetPath = joinPublicPath(parentPath(entry.path), name.trim());
      if (activeServerIsDemo) {
        const nextFiles = { ...demoFiles };
        for (const path of Object.keys(nextFiles)) {
          if (path === entry.path || path.startsWith(`${entry.path}/`)) {
            const replacement = path.replace(entry.path, targetPath);
            nextFiles[replacement] = nextFiles[path];
            delete nextFiles[path];
          }
        }
        setDemoFiles(nextFiles);
        setListing(demoListing(listing.path, nextFiles, demoInstalledMods));
      } else {
        await api(`/api/servers/${activeServer.id}/file`, {
          method: "PATCH",
          body: JSON.stringify({ path: entry.path, name: name.trim() })
        });
        await loadFiles(activeServer.id, listing.path);
      }
      setSelectedFilePaths([targetPath]);
      if (selectedPath && publicPathContains(entry.path, selectedPath)) {
        setSelectedPath(selectedPath.replace(entry.path, targetPath));
      }
      if (filePreview.path && publicPathContains(entry.path, filePreview.path)) {
        setFilePreview({ path: "", loading: false, data: null, error: "" });
      }
      notify("success", `Renamed to ${name.trim()}`);
    } catch (error) {
      notify("error", errorMessage(error, "Could not rename the selected item."));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function duplicateSelectedFile() {
    if (!activeServer || selectedEntries.length !== 1 || fileOperationBusy) return;
    if (!canDuplicateSelectedFile) return;
    const entry = selectedEntries[0];
    if (entry.type !== "file") return;
    const suggestedName = defaultDuplicateName(entry.name);
    const name = window.prompt("Duplicate file as", suggestedName);
    if (name === null) return;
    const nameError = fileNameValidation(name);
    if (nameError) {
      notify("error", nameError);
      return;
    }
    setFileOperationBusy("duplicate");
    try {
      const targetPath = joinPublicPath(parentPath(entry.path), name.trim());
      if (activeServerIsDemo) {
        const nextFiles = { ...demoFiles, [targetPath]: demoFiles[entry.path] ?? "" };
        setDemoFiles(nextFiles);
        setListing(demoListing(listing.path, nextFiles, demoInstalledMods));
      } else {
        await api(`/api/servers/${activeServer.id}/file/duplicate`, {
          method: "POST",
          body: JSON.stringify({ path: entry.path, name: name.trim() })
        });
        await loadFiles(activeServer.id, listing.path);
      }
      setSelectedFilePaths([targetPath]);
      notify("success", `Duplicated ${entry.name}`);
    } catch (error) {
      notify("error", errorMessage(error, "Could not duplicate the selected file."));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function saveFile() {
    if (isProvisioning || dockerOperationalLock || !canEditSelectedPath) return;
    if (!activeServer) return;
    if (!selectedPath || !dirty) return;
    if (serverRequiresStoppedForMutableConfig && isServerPropertiesPath(selectedPath)) {
      setFileLeaseMessage(stoppedServerMutationMessage);
      notify("warning", stoppedServerMutationMessage);
      return;
    }
    if (!fileEditMode || (!activeServerIsDemo && !fileEditLease)) return;
    if (fileSaving) return;
    setFileSaving(true);
    setNotice("");
    setFileReadError("");
    setFileOpenFailed(false);
    const pathError = validateSafePath(selectedPath);
    if (pathError) {
      setNotice(pathError);
      notify("error", pathError);
      setFileSaving(false);
      return;
    }
    if (new Blob([editorText]).size > 2 * 1024 * 1024) {
      const message = "File content is larger than the 2 MiB editor limit.";
      setNotice(message);
      notify("error", message);
      setFileSaving(false);
      return;
    }
    if (activeServerIsDemo) {
      const nextFiles = { ...demoFiles, [selectedPath]: editorText };
      setDemoFiles(nextFiles);
      setSavedEditorText(editorText);
      setDirty(false);
      setNotice(`Saved ${selectedPath}`);
      notify("success", `Saved ${selectedPath}`);
      setListing(demoListing(listing.path, nextFiles, demoInstalledMods));
      closeEditor();
      setFileSaving(false);
      return;
    }
    try {
      const result = await api<{ revision: string }>(`/api/servers/${activeServer.id}/file`, {
        method: "PUT",
        body: JSON.stringify({
          path: selectedPath,
          content: editorText,
          leaseId: fileEditLease?.leaseId,
          revision: fileRevision
        })
      });
      setSavedEditorText(editorText);
      setFileRevision(result.revision);
      setDirty(false);
      setNotice(`Saved ${selectedPath}`);
      notify("success", `Saved ${selectedPath}`);
      await loadFiles(activeServer.id, listing.path);
      closeEditor();
    } catch (error) {
      const conflict = error instanceof ApiError && (error.code === "FILE_REVISION_CONFLICT" || error.code === "FILE_EDIT_LEASE_LOST");
      const message = error instanceof ApiError && error.code === "FILE_REVISION_CONFLICT"
        ? "The file changed outside this editor. Your changes were not saved. Reload the file before editing again."
        : error instanceof ApiError && error.code === "FILE_EDIT_LEASE_LOST"
          ? "Your edit lease expired or was lost. Your changes were not saved. Reload the file before editing again."
          : errorMessage(error, "Could not save the file. Review the path and try again.");
      if (conflict) {
        releaseFileLease();
        setFileEditLease(null);
        setFileEditMode(false);
        setFileLeaseMessage(message);
      }
      setFileReadError(message);
      setFileOpenFailed(false);
      setNotice(message);
      notify("error", message);
    } finally {
      setFileSaving(false);
    }
  }

  function cancelFileEdit() {
    requestCloseEditor();
  }

  function clearWorkspace() {
    setListing({ path: "/", entries: [] });
    setFilesError("");
    setFilesLoading(false);
    setSelectedFilePaths([]);
    setFileBackStack([]);
    setFileForwardStack([]);
    setFilePreview({ path: "", loading: false, data: null, error: "" });
    resetEditorState();
  }

  function initializeDemoRoot() {
    setListing(demoListing("/", demoFiles, demoInstalledMods));
  }

  function setUnavailable(message: string) {
    setFilesError(message);
    setFilesLoading(false);
    setListing({ path: "/", entries: [] });
    setSelectedFilePaths([]);
    setFileBackStack([]);
    setFileForwardStack([]);
    setFilePreview({ path: "", loading: false, data: null, error: "" });
  }

  function resetPageState() {
    setSelectedFilePaths([]);
    setFileBackStack([]);
    setFileForwardStack([]);
    setFileReadError("");
    setFilePreview({ path: "", loading: false, data: null, error: "" });
    resetEditorState();
    if (activeServer) void navigateFiles("/");
  }

  return {
    data: {
      listing,
      selectedEntries,
      selectedEntry,
      selectedTotalSize,
      sortedFileRows,
      selectionSummary,
      fileBreadcrumbs,
      filePreview
    },
    state: {
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
    },
    refs: {
      fileUploadRef,
      fileSelectAllRef
    },
    table: fileTable,
    actions: {
      loadFiles,
      refreshCurrentFiles,
      navigateFiles,
      navigateBackFiles,
      navigateForwardFiles,
      activateFileEntry,
      openFile,
      createFolder,
      uploadFile,
      downloadSelectedItems,
      duplicateSelectedFile,
      renameSelectedFile,
      deleteSelectedFiles,
      saveFile,
      enterFileEditMode,
      cancelFileEdit,
      requestCloseEditor,
      discardEditorChanges,
      clearWorkspace,
      resetEditorState,
      initializeDemoRoot,
      setUnavailable,
      resetPageState,
      setFilesError,
      setFilesLoading,
      setListing,
      setFilePreview,
      setSelectedFilePaths,
      setEditorText,
      setDirty,
      setDiscardEditorRequest
    }
  };
}

export type FilesWorkspace = ReturnType<typeof useFilesWorkspace>;
