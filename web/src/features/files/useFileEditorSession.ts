import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { demoListing } from "../../demo";
import type { FileEditLease, FileListing, FilePreview, InstalledMod, ManagedServer, PublicUser } from "../../types";
import { isEditableFile } from "../../utils/files";
import { hasFileManagerPermission } from "../../utils/permissions";
import { validateSafePath } from "../../utils/validation";
import { errorMessage } from "../../utils/appHelpers";
import { fileEditBlockedReason, fileLeaseConflictMessage, fileSaveError, unsupportedEditorMessage } from "./fileEditorSession";

export type FileArchiveContext = {
  archivePath: string;
  path: string;
  encrypted: boolean;
};

export type DiscardEditorRequest = { action: "close" } | { action: "switch"; path: string };

type Notify = (type: "success" | "error" | "info" | "warning", text: string) => void;

type FileEditorSessionInputs = {
  activeServer: ManagedServer | null | undefined;
  activeServerIsDemo: boolean;
  archiveContext: FileArchiveContext | null;
  listing: FileListing;
  setListing: Dispatch<SetStateAction<FileListing>>;
  demoFiles: Record<string, string>;
  setDemoFiles: (updater: Record<string, string> | ((current: Record<string, string>) => Record<string, string>)) => void;
  demoInstalledMods: InstalledMod[];
  isProvisioning: boolean;
  dockerOperationalLock: boolean;
  runtimeControlsDisabledReason: string;
  serverRequiresStoppedForMutableConfig: boolean;
  stoppedServerMutationMessage: string;
  permissionUser: PublicUser | null;
  formatDisplayDate: (value: string | number | Date) => string;
  notify: Notify;
  setNotice: (message: string) => void;
  handleStaleSession: (error: unknown) => boolean;
  setSelectedFilePaths: Dispatch<SetStateAction<string[]>>;
  setFocusedFilePath: Dispatch<SetStateAction<string>>;
  setSelectionAnchorPath: Dispatch<SetStateAction<string>>;
  refreshFiles: (serverId: string, path: string) => Promise<unknown>;
};

export function useFileEditorSession({
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
  refreshFiles
}: FileEditorSessionInputs) {
  const [selectedPath, setSelectedPath] = useState("");
  const [editorText, setEditorText] = useState("");
  const [savedEditorText, setSavedEditorText] = useState("");
  const [fileRevision, setFileRevision] = useState("");
  const [fileEditLease, setFileEditLease] = useState<FileEditLease | null>(null);
  const [fileEditMode, setFileEditMode] = useState(false);
  const [fileLeaseBusy, setFileLeaseBusy] = useState(false);
  const [fileLeaseMessage, setFileLeaseMessage] = useState("");
  const [dirty, setDirty] = useState(false);
  const [fileReadError, setFileReadError] = useState("");
  const [fileOpenFailed, setFileOpenFailed] = useState(false);
  const [fileOpening, setFileOpening] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [discardEditorRequest, setDiscardEditorRequest] = useState<DiscardEditorRequest | null>(null);
  const fileEditLeaseRef = useRef<FileEditLease | null>(null);

  const editDisabledReason = fileEditBlockedReason(selectedPath, serverRequiresStoppedForMutableConfig, stoppedServerMutationMessage);
  const canEditSelectedPath = !archiveContext
    && !editDisabledReason
    && (activeServerIsDemo || (selectedPath ? hasFileManagerPermission(permissionUser, selectedPath, "edit") : false));

  function releaseFileLease(lease = fileEditLease) {
    if (!lease || activeServerIsDemo) return;
    void api(`/api/servers/${encodeURIComponent(lease.serverId)}/file/lease/${encodeURIComponent(lease.leaseId)}`, {
      method: "DELETE"
    }).catch(() => undefined);
  }

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
        if (handleStaleSession(error)) return;
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

  async function openFile(path: string, discardConfirmed = false) {
    if (isProvisioning || !activeServer) return;
    if (dockerOperationalLock) {
      const message = runtimeControlsDisabledReason || "Server files are unavailable until the runtime reconnects.";
      setNotice(message);
      notify("warning", message);
      return;
    }
    const openPermissionPath = archiveContext?.archivePath ?? path;
    if (!activeServerIsDemo && !hasFileManagerPermission(permissionUser, openPermissionPath, "view")) {
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
    setFocusedFilePath(path);
    setSelectionAnchorPath(path);
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
      if (archiveContext) {
        const preview = await api<FilePreview>(`/api/servers/${activeServer.id}/files/archive/preview?path=${encodeURIComponent(archiveContext.archivePath)}&entryPath=${encodeURIComponent(path)}`);
        if (preview.preview !== "text") throw new Error(preview.message || "This archive entry cannot be opened as text");
        setSelectedPath(path);
        setEditorText(preview.content ?? "");
        setSavedEditorText(preview.content ?? "");
        setFileRevision("");
        setFileEditMode(false);
        setDirty(false);
        setSelectedFilePaths([path]);
        return;
      }
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
      if (handleStaleSession(error)) return;
      const message = errorMessage(error, "Could not read this file. Check that the path is available and editable.");
      setFileReadError(message);
      setFileOpenFailed(true);
      setSelectedFilePaths([]);
      notify("error", message);
    } finally {
      setFileOpening(false);
    }
  }

  async function enterFileEditMode() {
    if (archiveContext) {
      setFileLeaseMessage("ZIP archive contents are read-only. Extract the archive before editing files.");
      return;
    }
    if (!activeServer || !selectedPath || !fileRevision || fileLeaseBusy || fileOpening || fileOpenFailed) return;
    if (editDisabledReason) {
      setFileLeaseMessage(editDisabledReason);
      notify("warning", editDisabledReason);
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
      if (handleStaleSession(error)) return;
      const message = error instanceof ApiError && error.code === "FILE_REVISION_CONFLICT"
        ? "This file changed since it was opened. Reload it before entering edit mode."
        : fileLeaseConflictMessage(error, formatDisplayDate);
      setFileLeaseMessage(message);
      notify("warning", message);
    } finally {
      setFileLeaseBusy(false);
    }
  }

  async function saveFile() {
    if (isProvisioning || dockerOperationalLock || !canEditSelectedPath || !activeServer) return;
    if (!selectedPath || !dirty) return;
    if (!fileEditMode || (!activeServerIsDemo && !fileEditLease) || fileSaving) return;
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
      await refreshFiles(activeServer.id, listing.path);
    } catch (error) {
      if (handleStaleSession(error)) return;
      const saveError = fileSaveError(error);
      if (saveError.conflict) {
        releaseFileLease();
        setFileEditLease(null);
        setFileEditMode(false);
        setFileLeaseMessage(saveError.message);
      }
      setFileReadError(saveError.message);
      setFileOpenFailed(false);
      setNotice(saveError.message);
      notify("error", saveError.message);
    } finally {
      setFileSaving(false);
    }
  }

  function cancelFileEdit() {
    requestCloseEditor();
  }

  return {
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
  };
}
