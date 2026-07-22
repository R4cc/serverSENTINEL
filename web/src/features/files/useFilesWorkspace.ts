import { type ChangeEvent, type Dispatch, type MutableRefObject, type SetStateAction, useEffect, useMemo, useRef, useState } from "react";
import { api, apiErrorFromResponse } from "../../api";
import { demoListing, demoServerId } from "../../demo";
import type { FileEntry, FileListing, FilePreview, GeneralJob, InstalledMod, ManagedServer, OperationRecord, PublicUser, ZipArchiveListing, ZipExtractionPlan } from "../../types";
import type { FilePreviewState } from "../../app/uiState";
import { isEditableFile, isPreviewableFile, joinPublicPath, parentPath } from "../../utils/files";
import { hasFileManagerPermission, isServerPropertiesPath } from "../../utils/permissions";
import { validateSafePath } from "../../utils/validation";
import { clearDeletedFileState, defaultDuplicateName, errorMessage, fileNameValidation, publicPathContains } from "../../utils/appHelpers";
import { formatBytes } from "../../utils/format";
import { adjacentFilePath, retainedFileFocus, updateFileSelection, type FileSelectionModifiers } from "./fileSelection";
import { writeStoredFileLocation } from "./fileLocationStorage";
import { fileMoveTargetPath, isFileMoveDestination, moveDemoFileTree } from "./fileMove";
import { defaultFileSort, nextFileSort, sortFileEntries } from "./fileSorting";
import { unsupportedEditorMessage } from "./fileEditorSession";
import { useFileEditorSession } from "./useFileEditorSession";

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
  setActiveJobs: Dispatch<SetStateAction<GeneralJob[]>>;
};

type FileLocation =
  | { kind: "filesystem"; path: string }
  | { kind: "archive"; archivePath: string; path: string };

export type FileActionDialog =
  | { kind: "create"; value: string; error: string }
  | { kind: "rename"; value: string; error: string; entry: FileEntry }
  | { kind: "duplicate"; value: string; error: string; entry: FileEntry }
  | { kind: "delete"; error: string; entries: FileEntry[] };

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
  refreshModsAfterFilesChange,
  setActiveJobs
}: UseFilesWorkspaceOptions) {
  const [listing, setListing] = useState<FileListing>({ path: "/", entries: [] });
  const [selectedFilePaths, setSelectedFilePaths] = useState<string[]>([]);
  const [focusedFilePath, setFocusedFilePath] = useState("");
  const [selectionAnchorPath, setSelectionAnchorPath] = useState("");
  const [fileActionDialog, setFileActionDialog] = useState<FileActionDialog | null>(null);
  const [archiveContext, setArchiveContext] = useState<{ archivePath: string; path: string; encrypted: boolean } | null>(null);
  const [fileBackStack, setFileBackStack] = useState<FileLocation[]>([]);
  const [fileForwardStack, setFileForwardStack] = useState<FileLocation[]>([]);
  const [fileSort, setFileSort] = useState(defaultFileSort);
  const [filePreview, setFilePreview] = useState<FilePreviewState>({ path: "", loading: false, data: null, error: "" });
  const [fileOperationBusy, setFileOperationBusy] = useState("");
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState("");
  const [zipDestinationListing, setZipDestinationListing] = useState<FileListing | null>(null);
  const [zipDestinationLoading, setZipDestinationLoading] = useState(false);
  const [zipConflictPlan, setZipConflictPlan] = useState<ZipExtractionPlan | null>(null);
  const [zipOperationId, setZipOperationId] = useState("");
  const fileUploadRef = useRef<HTMLInputElement>(null);
  const fileSelectAllRef = useRef<HTMLInputElement>(null);
  const trackedZipOperationsRef = useRef(new Set<string>());

  const {
    state: {
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
      canEditSelectedPath,
      editDisabledReason
    },
    actions: {
      openFile,
      saveFile,
      enterFileEditMode,
      cancelFileEdit,
      requestCloseEditor,
      discardEditorChanges,
      resetEditorState,
      setSelectedPath,
      setEditorText,
      setDirty,
      setFileReadError,
      setDiscardEditorRequest
    }
  } = useFileEditorSession({
    activeServer,
    activeServerIsDemo,
    archiveContext,
    listing,
    setListing,
    demoFiles,
    setDemoFiles,
    demoInstalledMods,
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
    setSelectedFilePaths,
    setFocusedFilePath,
    setSelectionAnchorPath,
    refreshFiles: (serverId, path) => loadFiles(serverId, path)
  });

  const permissionPath = archiveContext?.archivePath ?? listing.path;
  const canViewCurrentFiles = activeServerIsDemo || hasFileManagerPermission(permissionUser, permissionPath, "view");
  const canUploadToCurrentPath = !archiveContext && (activeServerIsDemo || hasFileManagerPermission(permissionUser, listing.path, "upload"));

  const selectedEntries = useMemo(() => {
    const selected = new Set(selectedFilePaths);
    return listing.entries.filter((entry) => selected.has(entry.path));
  }, [listing.entries, selectedFilePaths]);
  const selectedEntry = selectedEntries.length === 1 ? selectedEntries[0] : null;
  const selectedZipEntry = !archiveContext && selectedEntry?.type === "file" && /\.zip$/i.test(selectedEntry.name) ? selectedEntry : null;
  const selectedTotalSize = selectedEntries.reduce((total, entry) => total + (entry.type === "file" ? entry.size : 0), 0);
  const selectedTouchesServerSettings = selectedEntries.some((entry) => isServerPropertiesPath(entry.path));
  const selectedEntryTouchesServerSettings = Boolean(selectedEntry && isServerPropertiesPath(selectedEntry.path));
  const sortedFileEntries = useMemo(() => sortFileEntries(listing.entries, fileSort), [listing.entries, fileSort]);
  const sortedFilePaths = sortedFileEntries.map((entry) => entry.path);
  const selectedFilePathSet = useMemo(() => new Set(selectedFilePaths), [selectedFilePaths]);
  const allFilesSelected = sortedFilePaths.length > 0 && sortedFilePaths.every((path) => selectedFilePathSet.has(path));
  const someFilesSelected = !allFilesSelected && sortedFilePaths.some((path) => selectedFilePathSet.has(path));

  function selectFileEntry(path: string, modifiers: FileSelectionModifiers = {}) {
    const result = updateFileSelection(selectedFilePaths, sortedFilePaths, path, selectionAnchorPath, modifiers);
    setSelectedFilePaths(result.selectedPaths);
    setSelectionAnchorPath(result.anchorPath);
    setFocusedFilePath(path);
  }

  function clearFileSelection() {
    setSelectedFilePaths([]);
    setSelectionAnchorPath("");
    setFocusedFilePath("");
  }

  function toggleSelectAllFiles() {
    setSelectedFilePaths(allFilesSelected ? [] : sortedFilePaths);
  }

  function moveFileFocus(path: string, direction: -1 | 1, extendSelection = false) {
    const nextPath = adjacentFilePath(sortedFilePaths, path, direction);
    if (!nextPath) return "";
    setFocusedFilePath(nextPath);
    if (extendSelection) selectFileEntry(nextPath, { range: true });
    else {
      setSelectedFilePaths([nextPath]);
      setSelectionAnchorPath(nextPath);
    }
    return nextPath;
  }

  const selectionSummary = selectedEntries.length === 0
    ? "No selection"
    : `${selectedEntries.length} ${selectedEntries.length === 1 ? "item" : "items"} selected${selectedTotalSize > 0 ? ` - ${formatBytes(selectedTotalSize)}` : ""}`;
  const fileRuntimeLocked = isProvisioning || dockerOperationalLock;
  const archivePermission = (action: "view" | "download") => activeServerIsDemo || Boolean(archiveContext && hasFileManagerPermission(permissionUser, archiveContext.archivePath, action));
  const canOpenSelectedFile = Boolean(selectedEntry && selectedEntry.type === "file" && isEditableFile(selectedEntry) && (archiveContext ? archivePermission("view") : activeServerIsDemo || hasFileManagerPermission(permissionUser, selectedEntry.path, "view")) && !fileRuntimeLocked);
  const canOpenSelectedZip = Boolean(selectedZipEntry && !fileRuntimeLocked && !fileOperationBusy && (activeServerIsDemo || hasFileManagerPermission(permissionUser, selectedZipEntry.path, "view")));
  const canExtractSelectedZip = Boolean(selectedZipEntry && !activeServerIsDemo && !fileRuntimeLocked && !fileOperationBusy && !zipOperationId && hasFileManagerPermission(permissionUser, selectedZipEntry.path, "view"));
  const canDownloadSelectedItems = Boolean(selectedEntries.length > 0 && (archiveContext ? archivePermission("download") : selectedEntries.every((entry) => activeServerIsDemo || hasFileManagerPermission(permissionUser, entry.path, "download"))) && !fileRuntimeLocked && !fileOperationBusy);
  const canDuplicateSelectedFile = Boolean(!archiveContext && selectedEntry && selectedEntry.type === "file" && (activeServerIsDemo || hasFileManagerPermission(permissionUser, selectedEntry.path, "duplicate")) && !fileRuntimeLocked && !fileOperationBusy && !zipOperationId && !(serverRequiresStoppedForMutableConfig && selectedEntryTouchesServerSettings));
  const canRenameSelectedItem = Boolean(!archiveContext && selectedEntry && (activeServerIsDemo || hasFileManagerPermission(permissionUser, selectedEntry.path, "rename")) && !fileRuntimeLocked && !fileOperationBusy && !zipOperationId && !(serverRequiresStoppedForMutableConfig && selectedEntryTouchesServerSettings));
  const canDeleteSelectedItems = Boolean(!archiveContext && selectedEntries.length > 0 && selectedEntries.every((entry) => activeServerIsDemo || hasFileManagerPermission(permissionUser, entry.path, "delete")) && !fileRuntimeLocked && !fileOperationBusy && !zipOperationId && !(serverRequiresStoppedForMutableConfig && selectedTouchesServerSettings));

  function canDragFileEntry(entry: FileEntry) {
    return !archiveContext
      && !fileRuntimeLocked
      && !fileOperationBusy
      && !zipOperationId
      && !(serverRequiresStoppedForMutableConfig && isServerPropertiesPath(entry.path))
      && (activeServerIsDemo || hasFileManagerPermission(permissionUser, entry.path, "rename"));
  }

  function canMoveFileEntry(entry: FileEntry, destinationPath: string) {
    if (!canDragFileEntry(entry) || !isFileMoveDestination(entry, destinationPath)) return false;
    const targetPath = fileMoveTargetPath(entry, destinationPath);
    if (serverRequiresStoppedForMutableConfig && isServerPropertiesPath(targetPath)) return false;
    return activeServerIsDemo || hasFileManagerPermission(permissionUser, targetPath, "rename");
  }
  const fileActionBlockedReason = isProvisioning
    ? "Server setup is still running."
    : dockerOperationalLock
      ? runtimeControlsDisabledReason || "Server files are unavailable until the runtime reconnects."
      : serverRequiresStoppedForMutableConfig && selectedTouchesServerSettings
        ? stoppedServerMutationMessage
      : fileOperationBusy
        ? "A file operation is already running."
        : zipOperationId
          ? "ZIP extraction is running. File mutations are temporarily disabled."
        : "";
  const fileReadActionBlockedReason = isProvisioning
    ? "Server setup is still running."
    : dockerOperationalLock
      ? runtimeControlsDisabledReason || "Server files are unavailable until the runtime reconnects."
      : fileOperationBusy
        ? "A file operation is already running."
        : "";
  const fileBreadcrumbs = useMemo(() => {
    if (archiveContext) {
      const archiveParts = archiveContext.archivePath.split("/").filter(Boolean);
      const archiveName = archiveParts.pop() ?? archiveContext.archivePath;
      const entryParts = archiveContext.path.split("/").filter(Boolean);
      return [
        { label: "/", path: "/", kind: "filesystem" as const },
        ...archiveParts.map((part, index) => ({ label: part, path: `/${archiveParts.slice(0, index + 1).join("/")}`, kind: "filesystem" as const })),
        { label: archiveName, path: "/", kind: "archive" as const },
        ...entryParts.map((part, index) => ({ label: part, path: `/${entryParts.slice(0, index + 1).join("/")}`, kind: "archive" as const }))
      ];
    }
    const parts = listing.path.split("/").filter(Boolean);
    return [
      { label: "/", path: "/", kind: "filesystem" as const },
      ...parts.map((part, index) => ({ label: part, path: `/${parts.slice(0, index + 1).join("/")}`, kind: "filesystem" as const }))
    ];
  }, [listing.path, archiveContext]);

  useEffect(() => {
    if (fileSelectAllRef.current) {
      fileSelectAllRef.current.indeterminate = someFilesSelected;
    }
  }, [someFilesSelected]);

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

  async function loadFiles(serverId: string, path: string, historyMode: "replace" | "push" | "back" | "forward" = "replace", preserveSelection = false) {
    if (isProvisioning) return false;
    if (!activeServerIsDemo && !hasFileManagerPermission(permissionUser, path, "view")) {
      const message = "View files permission is required for this folder.";
      setFilesError(message);
      setNotice(message);
      return false;
    }
    const previousLocation: FileLocation = archiveContext
      ? { kind: "archive", archivePath: archiveContext.archivePath, path: archiveContext.path }
      : { kind: "filesystem", path: listing.path };
    setFilesLoading(true);
    setFilesError("");
    setNotice("");
    if (demoMode && serverId === demoServerId) {
      if (activeServerIdRef.current === serverId) {
        const nextListing = demoListing(path, demoFiles, demoInstalledMods);
        setListing(nextListing);
        writeStoredFileLocation(serverId, nextListing.path);
        setArchiveContext(null);
        setSelectedFilePaths((current) => preserveSelection ? current.filter((entryPath) => nextListing.entries.some((entry) => entry.path === entryPath)) : []);
        setFocusedFilePath((current) => preserveSelection ? retainedFileFocus(current, nextListing.entries.map((entry) => entry.path)) : "");
        if (!preserveSelection) setSelectionAnchorPath("");
        setFilePreview({ path: "", loading: false, data: null, error: "" });
        if (historyMode === "push" && (previousLocation.kind !== "filesystem" || nextListing.path !== previousLocation.path)) {
          setFileBackStack((current) => [...current, previousLocation].slice(-50));
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
        writeStoredFileLocation(serverId, nextListing.path);
        setArchiveContext(null);
        setSelectedFilePaths((current) => preserveSelection ? current.filter((entryPath) => nextListing.entries.some((entry) => entry.path === entryPath)) : []);
        setFocusedFilePath((current) => preserveSelection ? retainedFileFocus(current, nextListing.entries.map((entry) => entry.path)) : "");
        if (!preserveSelection) setSelectionAnchorPath("");
        setFilePreview({ path: "", loading: false, data: null, error: "" });
        setFilesError("");
        if (historyMode === "push" && (previousLocation.kind !== "filesystem" || nextListing.path !== previousLocation.path)) {
          setFileBackStack((current) => [...current, previousLocation].slice(-50));
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

  async function loadArchive(serverId: string, archivePath: string, entryPath = "/", historyMode: "replace" | "push" | "back" | "forward" = "push", preserveSelection = false) {
    if (isProvisioning || activeServerIsDemo) return false;
    if (!hasFileManagerPermission(permissionUser, archivePath, "view")) {
      notify("warning", "View files permission is required to open this ZIP archive.");
      return false;
    }
    const previousLocation: FileLocation = archiveContext
      ? { kind: "archive", archivePath: archiveContext.archivePath, path: archiveContext.path }
      : { kind: "filesystem", path: listing.path };
    setFilesLoading(true);
    setFilesError("");
    try {
      const next = await api<ZipArchiveListing>(`/api/servers/${serverId}/files/archive?path=${encodeURIComponent(archivePath)}&entryPath=${encodeURIComponent(entryPath)}`);
      setListing({ path: next.path, entries: next.entries });
      setArchiveContext({ archivePath: next.archivePath, path: next.path, encrypted: next.encrypted });
      setSelectedFilePaths((current) => preserveSelection ? current.filter((entryPathValue) => next.entries.some((entry) => entry.path === entryPathValue)) : []);
      setFocusedFilePath((current) => preserveSelection ? retainedFileFocus(current, next.entries.map((entry) => entry.path)) : "");
      if (!preserveSelection) setSelectionAnchorPath("");
      setFilePreview({ path: "", loading: false, data: null, error: "" });
      if (historyMode === "push" && (previousLocation.kind !== "archive" || previousLocation.archivePath !== next.archivePath || previousLocation.path !== next.path)) {
        setFileBackStack((current) => [...current, previousLocation].slice(-50));
        setFileForwardStack([]);
      }
      return true;
    } catch (error) {
      const message = errorMessage(error, "Could not open the ZIP archive.");
      setFilesError(message);
      notify("error", message);
      return false;
    } finally {
      setFilesLoading(false);
    }
  }

  async function navigateArchive(path: string) {
    if (!activeServer || !archiveContext) return;
    await loadArchive(activeServer.id, archiveContext.archivePath, path, "push");
  }

  async function loadLocation(location: FileLocation, historyMode: "back" | "forward") {
    if (!activeServer) return false;
    return location.kind === "archive"
      ? loadArchive(activeServer.id, location.archivePath, location.path, historyMode)
      : loadFiles(activeServer.id, location.path, historyMode);
  }

  async function refreshCurrentFiles() {
    if (!activeServer) return;
    if (archiveContext) await loadArchive(activeServer.id, archiveContext.archivePath, archiveContext.path, "replace", true);
    else await loadFiles(activeServer.id, listing.path, "replace", true);
  }

  async function navigateFilesUp() {
    if (archiveContext) {
      if (archiveContext.path === "/") await navigateFiles(parentPath(archiveContext.archivePath));
      else await navigateArchive(parentPath(archiveContext.path));
      return;
    }
    if (listing.path !== "/") await navigateFiles(parentPath(listing.path));
  }

  async function navigateBackFiles() {
    if (!activeServer || fileBackStack.length === 0) return;
    const target = fileBackStack[fileBackStack.length - 1];
    const current: FileLocation = archiveContext ? { kind: "archive", archivePath: archiveContext.archivePath, path: archiveContext.path } : { kind: "filesystem", path: listing.path };
    const loaded = await loadLocation(target, "back");
    if (loaded) {
      setFileBackStack((current) => current.slice(0, -1));
      setFileForwardStack((entries) => [current, ...entries].slice(0, 50));
    }
  }

  async function navigateForwardFiles() {
    if (!activeServer || fileForwardStack.length === 0) return;
    const target = fileForwardStack[0];
    const current: FileLocation = archiveContext ? { kind: "archive", archivePath: archiveContext.archivePath, path: archiveContext.path } : { kind: "filesystem", path: listing.path };
    const loaded = await loadLocation(target, "forward");
    if (loaded) {
      setFileForwardStack((current) => current.slice(1));
      setFileBackStack((entries) => [...entries, current].slice(-50));
    }
  }

  function activateFileEntry(entry: FileEntry) {
    if (entry.type === "directory") {
      if (archiveContext) void navigateArchive(entry.path);
      else void navigateFiles(entry.path);
      return;
    }
    if (!archiveContext && /\.zip$/i.test(entry.name) && activeServer && !activeServerIsDemo) {
      setSelectedFilePaths([entry.path]);
      setFocusedFilePath(entry.path);
      setSelectionAnchorPath(entry.path);
      if (fileRuntimeLocked || fileOperationBusy) return;
      void loadArchive(activeServer.id, entry.path, "/", "push");
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
    const previewPermissionPath = archiveContext?.archivePath ?? entry.path;
    if (!activeServerIsDemo && !hasFileManagerPermission(permissionUser, previewPermissionPath, "view")) {
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
      const previewUrl = archiveContext
        ? `/api/servers/${activeServer.id}/files/archive/preview?path=${encodeURIComponent(archiveContext.archivePath)}&entryPath=${encodeURIComponent(entry.path)}`
        : `/api/servers/${activeServer.id}/file/preview?path=${encodeURIComponent(entry.path)}`;
      const preview = await api<FilePreview>(previewUrl);
      setFilePreview((current) => current.path === entry.path
        ? { path: entry.path, loading: false, data: preview, error: "" }
        : current);
    } catch (error) {
      setFilePreview((current) => current.path === entry.path
        ? { path: entry.path, loading: false, data: null, error: errorMessage(error, "Could not load a preview for this file.") }
        : current);
    }
  }

  function openCreateFolderDialog() {
    if (fileRuntimeLocked || !canUploadToCurrentPath || fileOperationBusy) return;
    setFileActionDialog({ kind: "create", value: "", error: "" });
  }

  function openRenameDialog() {
    if (!selectedEntry || !canRenameSelectedItem) return;
    setFileActionDialog({ kind: "rename", value: selectedEntry.name, error: "", entry: selectedEntry });
  }

  function openDuplicateDialog() {
    if (!selectedEntry || !canDuplicateSelectedFile) return;
    setFileActionDialog({ kind: "duplicate", value: defaultDuplicateName(selectedEntry.name), error: "", entry: selectedEntry });
  }

  function openDeleteDialog() {
    if (!canDeleteSelectedItems) return;
    setFileActionDialog({ kind: "delete", error: "", entries: [...selectedEntries] });
  }

  function closeFileActionDialog() {
    if (!fileOperationBusy) setFileActionDialog(null);
  }

  function setFileActionDialogValue(value: string) {
    setFileActionDialog((current) => current && current.kind !== "delete" ? { ...current, value, error: "" } : current);
  }

  async function submitFileActionDialog() {
    const dialog = fileActionDialog;
    if (!dialog || fileOperationBusy) return;
    if (dialog.kind !== "delete") {
      const nameError = fileNameValidation(dialog.value);
      if (nameError) {
        setFileActionDialog({ ...dialog, error: nameError });
        return;
      }
    }
    if (dialog.kind === "create") await createFolder(dialog.value.trim());
    else if (dialog.kind === "rename") await renameSelectedFile(dialog.value.trim(), dialog.entry);
    else if (dialog.kind === "duplicate") await duplicateSelectedFile(dialog.value.trim(), dialog.entry);
    else await deleteSelectedFiles(dialog.entries);
  }

  async function deleteSelectedFiles(entries = selectedEntries) {
    if (!activeServer || entries.length === 0 || fileOperationBusy) return;
    if (isProvisioning || dockerOperationalLock || !canDeleteSelectedItems) return;
    const invalidPath = entries.map((entry) => validateSafePath(entry.path)).find(Boolean);
    if (invalidPath) {
      setNotice(invalidPath);
      notify("error", invalidPath);
      setFileActionDialog((current) => current?.kind === "delete" ? { ...current, error: invalidPath } : current);
      return;
    }
    setFileOperationBusy("delete");
    setNotice("");
    try {
      if (activeServerIsDemo) {
        const deletedEntries = [...entries];
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
        setFileActionDialog(null);
        notify("success", entries.length === 1 ? `Deleted ${entries[0].name}` : `Deleted ${entries.length} items`);
        return;
      }

      const failures: string[] = [];
      const deletedEntries: FileEntry[] = [];
      const deleteTargets = entries.filter((entry) => !entries.some((candidate) => (
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
        setFileActionDialog(null);
      }
      await loadFiles(activeServer.id, listing.path);
      await refreshModsAfterFilesChange();
      if (failures.length) {
        const message = `Could not delete ${failures.length} item${failures.length === 1 ? "" : "s"}: ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "; ..." : ""}`;
        setNotice(message);
        notify("error", message);
        if (!deletedEntries.length) setFileActionDialog((current) => current?.kind === "delete" ? { ...current, error: message } : current);
      }
    } finally {
      setFileOperationBusy("");
    }
  }

  async function createFolder(name: string) {
    if (!activeServer || fileOperationBusy) return;
    if (fileRuntimeLocked || !canUploadToCurrentPath) return;
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
      const folderPath = joinPublicPath(listing.path, name.trim());
      setSelectedFilePaths([folderPath]);
      setFocusedFilePath(folderPath);
      setSelectionAnchorPath(folderPath);
      setFileActionDialog(null);
      notify("success", `Created ${name.trim()}`);
    } catch (error) {
      const message = errorMessage(error, "Could not create the folder.");
      setFileActionDialog((current) => current?.kind === "create" ? { ...current, error: message } : current);
      notify("error", message);
    } finally {
      setFileOperationBusy("");
    }
  }

  async function uploadFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !activeServer || fileOperationBusy) return;
    if (fileRuntimeLocked || !canUploadToCurrentPath) return;
    const nameError = fileNameValidation(file.name);
    if (nameError) {
      notify("error", nameError);
      return;
    }
    if (file.size > 256 * 1024 * 1024) {
      notify("error", "Upload is larger than the 256 MiB file manager limit.");
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
        const form = new FormData();
        form.append("path", listing.path);
        form.append("size", String(file.size));
        form.append("file", file, file.name);
        await api(`/api/servers/${activeServer.id}/files/upload`, {
          method: "POST",
          body: form
        });
        await loadFiles(activeServer.id, listing.path);
      }
      setSelectedFilePaths([targetPath]);
      setFocusedFilePath(targetPath);
      setSelectionAnchorPath(targetPath);
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
        "X-Requested-With": "XMLHttpRequest"
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

  async function downloadResponse(response: Response, fallbackFilename: string) {
    if (!response.ok) throw await apiErrorFromResponse(response);
    const disposition = response.headers.get("content-disposition") ?? "";
    const encodedName = disposition.match(/filename="([^"]+)"/)?.[1];
    const filename = encodedName ? decodeURIComponent(encodedName) : fallbackFilename;
    const objectUrl = URL.createObjectURL(await response.blob());
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
      } else if (archiveContext) {
        if (selectedEntries.length === 1 && selectedEntries[0].type === "file") {
          await downloadUrl(`/api/servers/${activeServer.id}/files/archive/download?path=${encodeURIComponent(archiveContext.archivePath)}&entryPath=${encodeURIComponent(selectedEntries[0].path)}`, selectedEntries[0].name);
        } else {
          await downloadResponse(await fetch(`/api/servers/${activeServer.id}/files/archive/download`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
            credentials: "same-origin",
            body: JSON.stringify({ path: archiveContext.archivePath, entryPaths: selectedEntries.map((entry) => entry.path) })
          }), "archive-selection.zip");
        }
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

  function zipDestinationName(filename: string) {
    return filename.replace(/\.zip$/i, "").trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_") || "archive";
  }

  async function openSelectedZip() {
    if (!activeServer || !selectedZipEntry || !canOpenSelectedZip) return;
    await loadArchive(activeServer.id, selectedZipEntry.path, "/", "push");
  }

  async function waitForZipOperation(operationId: string) {
    try {
      for (;;) {
        const operation = await api<OperationRecord>(`/api/operations/${operationId}`);
        setActiveJobs((current) => current.map((job) => job.id === operationId ? {
          ...job,
          status: operation.status,
          progress: operation.progress,
          task: operation.task,
          error: operation.errorMessage,
          dismissible: operation.status !== "queued" && operation.status !== "running"
        } : job));
        if (operation.status === "succeeded") {
          setActiveJobs((current) => current.map((job) => job.id === operationId ? {
            ...job,
            finalNotification: { type: "success", text: "ZIP extraction completed." },
            dismissible: true
          } : job));
          if (!archiveContext && activeServer) await loadFiles(activeServer.id, listing.path);
          await refreshModsAfterFilesChange();
          return;
        }
        if (operation.status === "failed" || operation.status === "cancelled") {
          setActiveJobs((current) => current.map((job) => job.id === operationId ? {
            ...job,
            finalNotification: { type: "error", text: operation.errorMessage || "ZIP extraction failed." },
            dismissible: true
          } : job));
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1000));
      }
    } catch (error) {
      notify("error", errorMessage(error, "Could not monitor ZIP extraction."));
    } finally {
      trackedZipOperationsRef.current.delete(operationId);
      setZipOperationId("");
    }
  }

  function resumeZipOperation(operation: OperationRecord) {
    if (operation.type !== "file.extract" || (operation.status !== "queued" && operation.status !== "running")) return;
    if (trackedZipOperationsRef.current.has(operation.id)) return;
    trackedZipOperationsRef.current.add(operation.id);
    const metadata = operation.result as { archivePath?: string } | undefined;
    const subject = metadata?.archivePath?.split("/").filter(Boolean).pop() || "ZIP archive";
    setZipOperationId(operation.id);
    setActiveJobs((current) => current.some((job) => job.id === operation.id) ? current : [...current, {
      id: operation.id,
      type: "file-extract",
      status: operation.status,
      title: "Extracting ZIP archive",
      subject,
      progress: operation.progress,
      task: operation.task || "Extracting archive",
      dismissible: false
    }]);
    void waitForZipOperation(operation.id);
  }

  async function startZipExtraction(plan: ZipExtractionPlan, conflictPolicy: "replace" | "skip") {
    if (!activeServer || !selectedZipEntry || zipOperationId) return;
    setZipConflictPlan(null);
    try {
      const operation = await api<OperationRecord>(`/api/servers/${activeServer.id}/files/archive/extract`, {
        method: "POST",
        body: JSON.stringify({ path: selectedZipEntry.path, destinationPath: plan.destinationPath, conflictPolicy })
      });
      trackedZipOperationsRef.current.add(operation.id);
      setZipOperationId(operation.id);
      setActiveJobs((current) => [...current.filter((job) => job.id !== operation.id), {
        id: operation.id,
        type: "file-extract",
        status: operation.status,
        title: "Extracting ZIP archive",
        subject: selectedZipEntry.name,
        progress: operation.progress,
        task: operation.task || "Starting extraction",
        dismissible: false
      }]);
      void waitForZipOperation(operation.id);
    } catch (error) {
      notify("error", errorMessage(error, "Could not start ZIP extraction."));
    }
  }

  async function planSelectedZipExtraction(destinationPath: string) {
    if (!activeServer || !selectedZipEntry || !canExtractSelectedZip) return;
    setFileOperationBusy("zip-plan");
    try {
      const plan = await api<ZipExtractionPlan>(`/api/servers/${activeServer.id}/files/archive/extract/plan`, {
        method: "POST",
        body: JSON.stringify({ path: selectedZipEntry.path, destinationPath })
      });
      if (plan.blocked.length) {
        notify("error", `Extraction is blocked by ${plan.blocked[0].path}.`);
        return;
      }
      if (plan.conflicts.length) setZipConflictPlan(plan);
      else await startZipExtraction(plan, "replace");
    } catch (error) {
      notify("error", errorMessage(error, "Could not prepare ZIP extraction."));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function extractSelectedZipHere() {
    if (!selectedZipEntry) return;
    await planSelectedZipExtraction(parentPath(selectedZipEntry.path));
  }

  async function extractSelectedZipToFolder() {
    if (!selectedZipEntry) return;
    await planSelectedZipExtraction(joinPublicPath(parentPath(selectedZipEntry.path), zipDestinationName(selectedZipEntry.name)));
  }

  async function loadZipDestination(path: string) {
    if (!activeServer) return;
    setZipDestinationLoading(true);
    try {
      const destination = await api<FileListing>(`/api/servers/${activeServer.id}/files?path=${encodeURIComponent(path)}`);
      setZipDestinationListing(destination);
    } catch (error) {
      notify("error", errorMessage(error, "Could not load extraction destinations."));
    } finally {
      setZipDestinationLoading(false);
    }
  }

  async function openZipDestinationPicker() {
    if (!selectedZipEntry || !canExtractSelectedZip) return;
    await loadZipDestination(parentPath(selectedZipEntry.path));
  }

  async function confirmZipDestination() {
    const destination = zipDestinationListing?.path;
    setZipDestinationListing(null);
    if (destination) await planSelectedZipExtraction(destination);
  }

  async function renameSelectedFile(name: string, entry = selectedEntry) {
    if (!activeServer || !entry || fileOperationBusy) return;
    if (!canRenameSelectedItem) return;
    if (dirty && selectedPath && publicPathContains(entry.path, selectedPath)) {
      const message = "Save or discard the open editor changes before renaming this item.";
      setNotice(message);
      notify("warning", message);
      setFileActionDialog((current) => current?.kind === "rename" ? { ...current, error: message } : current);
      return;
    }
    if (name.trim() === entry.name) {
      setFileActionDialog(null);
      return;
    }
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
      setFocusedFilePath(targetPath);
      setSelectionAnchorPath(targetPath);
      if (selectedPath && publicPathContains(entry.path, selectedPath)) {
        setSelectedPath(selectedPath.replace(entry.path, targetPath));
      }
      if (filePreview.path && publicPathContains(entry.path, filePreview.path)) {
        setFilePreview({ path: "", loading: false, data: null, error: "" });
      }
      setFileActionDialog(null);
      notify("success", `Renamed to ${name.trim()}`);
    } catch (error) {
      const message = errorMessage(error, "Could not rename the selected item.");
      setFileActionDialog((current) => current?.kind === "rename" ? { ...current, error: message } : current);
      notify("error", message);
    } finally {
      setFileOperationBusy("");
    }
  }

  async function moveFileEntry(entry: FileEntry, destinationPath: string) {
    if (!activeServer || fileOperationBusy || !canMoveFileEntry(entry, destinationPath)) return;
    if (dirty && selectedPath && publicPathContains(entry.path, selectedPath)) {
      const message = "Save or discard the open editor changes before moving this item.";
      setNotice(message);
      notify("warning", message);
      return;
    }
    const targetPath = fileMoveTargetPath(entry, destinationPath);
    setFileOperationBusy("move");
    try {
      if (activeServerIsDemo) {
        let nextFiles = moveDemoFileTree(demoFiles, entry.path, targetPath);
        const movedDemoMod = demoInstalledMods.find((mod) => `/mods/${mod.filename}` === entry.path);
        if (movedDemoMod) {
          nextFiles = { ...nextFiles, [targetPath]: `Demo mod file: ${movedDemoMod.displayName || movedDemoMod.filename}` };
          setDemoInstalledMods((current) => current.filter((mod) => mod.filename !== movedDemoMod.filename));
        }
        setDemoFiles(nextFiles);
        setListing(demoListing(listing.path, nextFiles, movedDemoMod ? demoInstalledMods.filter((mod) => mod.filename !== movedDemoMod.filename) : demoInstalledMods));
      } else {
        await api(`/api/servers/${activeServer.id}/file/move`, {
          method: "POST",
          body: JSON.stringify({ path: entry.path, destinationPath })
        });
        await loadFiles(activeServer.id, listing.path);
        await refreshModsAfterFilesChange();
      }
      setSelectedFilePaths([]);
      setFocusedFilePath("");
      setSelectionAnchorPath("");
      if (selectedPath && publicPathContains(entry.path, selectedPath)) {
        resetEditorState();
      }
      if (filePreview.path && publicPathContains(entry.path, filePreview.path)) {
        setFilePreview({ path: "", loading: false, data: null, error: "" });
      }
      notify("success", `Moved ${entry.name} to ${destinationPath}`);
    } catch (error) {
      notify("error", errorMessage(error, `Could not move ${entry.name}.`));
    } finally {
      setFileOperationBusy("");
    }
  }

  async function duplicateSelectedFile(name: string, entry = selectedEntry) {
    if (!activeServer || !entry || fileOperationBusy) return;
    if (!canDuplicateSelectedFile) return;
    if (entry.type !== "file") return;
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
      setFocusedFilePath(targetPath);
      setSelectionAnchorPath(targetPath);
      setFileActionDialog(null);
      notify("success", `Duplicated ${entry.name}`);
    } catch (error) {
      const message = errorMessage(error, "Could not duplicate the selected file.");
      setFileActionDialog((current) => current?.kind === "duplicate" ? { ...current, error: message } : current);
      notify("error", message);
    } finally {
      setFileOperationBusy("");
    }
  }

  function clearWorkspace() {
    setListing({ path: "/", entries: [] });
    setArchiveContext(null);
    setFilesError("");
    setFilesLoading(false);
    setSelectedFilePaths([]);
    setFocusedFilePath("");
    setSelectionAnchorPath("");
    setFileActionDialog(null);
    setFileBackStack([]);
    setFileForwardStack([]);
    setFilePreview({ path: "", loading: false, data: null, error: "" });
    resetEditorState();
  }

  function initializeDemoRoot(path = "/") {
    setArchiveContext(null);
    const nextListing = demoListing(path, demoFiles, demoInstalledMods);
    setListing(nextListing);
    writeStoredFileLocation(demoServerId, nextListing.path);
  }

  function setUnavailable(message: string) {
    setFilesError(message);
    setFilesLoading(false);
    setListing({ path: "/", entries: [] });
    setArchiveContext(null);
    setSelectedFilePaths([]);
    setFocusedFilePath("");
    setSelectionAnchorPath("");
    setFileActionDialog(null);
    setFileBackStack([]);
    setFileForwardStack([]);
    setFilePreview({ path: "", loading: false, data: null, error: "" });
  }

  function resetPageState() {
    setSelectedFilePaths([]);
    setFocusedFilePath("");
    setSelectionAnchorPath("");
    setFileActionDialog(null);
    setFileBackStack([]);
    setFileForwardStack([]);
    setFileReadError("");
    setFilePreview({ path: "", loading: false, data: null, error: "" });
    setArchiveContext(null);
    setZipDestinationListing(null);
    setZipConflictPlan(null);
    resetEditorState();
    if (activeServer) void navigateFiles("/");
  }

  return {
    data: {
      listing,
      archiveContext,
      selectedEntries,
      selectedEntry,
      selectedZipEntry,
      selectedTotalSize,
      sortedFileEntries,
      selectionSummary,
      fileBreadcrumbs,
      filePreview,
      zipDestinationListing,
      zipConflictPlan
    },
    state: {
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
      editDisabledReason,
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
      zipOperationId,
      selectedFilePaths,
      fileSort,
      allFilesSelected
    },
    refs: {
      fileUploadRef,
      fileSelectAllRef
    },
    actions: {
      loadFiles,
      refreshCurrentFiles,
      navigateFiles,
      navigateArchive,
      loadArchive,
      navigateBackFiles,
      navigateForwardFiles,
      navigateFilesUp,
      activateFileEntry,
      selectFileEntry,
      clearFileSelection,
      toggleSelectAllFiles,
      toggleFileSort: (id: Parameters<typeof nextFileSort>[1]) => setFileSort((current) => nextFileSort(current, id)),
      moveFileFocus,
      canDragFileEntry,
      canMoveFileEntry,
      moveFileEntry,
      openFile,
      openCreateFolderDialog,
      uploadFile,
      downloadSelectedItems,
      openSelectedZip,
      extractSelectedZipHere,
      extractSelectedZipToFolder,
      openZipDestinationPicker,
      loadZipDestination,
      confirmZipDestination,
      startZipExtraction,
      resumeZipOperation,
      openDuplicateDialog,
      openRenameDialog,
      openDeleteDialog,
      closeFileActionDialog,
      setFileActionDialogValue,
      submitFileActionDialog,
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
      setFocusedFilePath,
      setEditorText,
      setDirty,
      setDiscardEditorRequest,
      setZipDestinationListing,
      setZipConflictPlan
    }
  };
}

export type FilesWorkspace = ReturnType<typeof useFilesWorkspace>;
