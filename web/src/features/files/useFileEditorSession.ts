import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api";
import { demoFixtures } from "../../demoRuntime";
import type { FileEditLease, FileListing, InstalledMod, ManagedServer, Notify, PublicUser } from "../../types";
import { isEditableFile } from "../../utils/files";
import { hasFileManagerPermission } from "../../utils/permissions";
import { validateSafePath } from "../../utils/validation";
import { errorMessage } from "../../utils/appHelpers";
import { fileEditBlockedReason, fileLeaseConflictMessage, fileSaveError, unsupportedEditorMessage } from "./fileEditorSession";

type DiscardEditorRequest = { action: "close" } | { action: "switch"; path: string };

type FileEditorSessionInputs = {
  activeServer: ManagedServer | null | undefined;
  activeServerIsDemo: boolean;
  listing: FileListing;
  setListing: Dispatch<SetStateAction<FileListing>>;
  demoFiles: Record<string, string>;
  setDemoFiles: (updater: Record<string, string> | ((current: Record<string, string>) => Record<string, string>)) => void;
  demoInstalledMods: InstalledMod[];
  isProvisioning: boolean;
  dockerOperationalLock: boolean;
  serverMutationLocked?: boolean;
  serverMutationBlockedReason?: string;
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
  listing,
  setListing,
  demoFiles,
  setDemoFiles,
  demoInstalledMods,
  isProvisioning,
  dockerOperationalLock,
  serverMutationLocked = false,
  serverMutationBlockedReason = "",
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
  const [fileEditLease, updateFileEditLease] = useState<FileEditLease | null>(null);
  const [fileEditMode, setFileEditMode] = useState(false);
  const [fileLeaseBusy, setFileLeaseBusy] = useState(false);
  const [fileLeaseMessage, setFileLeaseMessage] = useState("");
  const dirty = editorText !== savedEditorText;
  const [fileReadError, setFileReadError] = useState("");
  const [fileOpenFailed, setFileOpenFailed] = useState(false);
  const [fileOpening, setFileOpening] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [discardEditorRequest, setDiscardEditorRequest] = useState<DiscardEditorRequest | null>(null);
  const fileEditLeaseRef = useRef<FileEditLease | null>(null);
  const requestOwnerRef = useRef(0);
  const pendingLeaseRef = useRef(false);
  const pendingSaveRef = useRef(false);
  const scope = JSON.stringify([activeServer?.id, activeServerIsDemo, permissionUser]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;

  function ownsRequest(owner: number) {
    return requestOwnerRef.current === owner && scopeRef.current === scope;
  }

  function setFileEditLease(lease: FileEditLease | null) {
    fileEditLeaseRef.current = lease;
    updateFileEditLease(lease);
  }

  useEffect(() => {
    resetEditorState();
    return () => {
      requestOwnerRef.current++;
      releaseFileLease();
      fileEditLeaseRef.current = null;
    };
  }, [scope]);

  const editDisabledReason = serverMutationLocked
    ? serverMutationBlockedReason
    : fileEditBlockedReason(selectedPath, serverRequiresStoppedForMutableConfig, stoppedServerMutationMessage);
  const canEditSelectedPath = !editDisabledReason
    && (activeServerIsDemo || (selectedPath ? hasFileManagerPermission(permissionUser, selectedPath, "edit") : false));

  function releaseFileLease(lease = fileEditLeaseRef.current) {
    if (!lease) return;
    void api(`/api/servers/${encodeURIComponent(lease.serverId)}/file/lease/${encodeURIComponent(lease.leaseId)}`, {
      method: "DELETE"
    }).catch(() => undefined);
  }

  useEffect(() => {
    if (!fileEditLease || !fileEditMode || activeServerIsDemo || fileSaving) return;
    const owner = requestOwnerRef.current;
    let cancelled = false;
    let pending = false;
    const ownsHeartbeat = () => !cancelled && ownsRequest(owner)
      && !pendingSaveRef.current && fileEditLeaseRef.current?.leaseId === fileEditLease.leaseId;
    const heartbeat = async () => {
      if (pending || !ownsHeartbeat()) return;
      pending = true;
      try {
        const result = await api<{ lease: FileEditLease }>(
          `/api/servers/${encodeURIComponent(fileEditLease.serverId)}/file/lease/${encodeURIComponent(fileEditLease.leaseId)}/heartbeat`,
          { method: "POST" }
        );
        if (!ownsHeartbeat()) return;
        setFileEditLease(result.lease);
      } catch (error) {
        if (!ownsHeartbeat() || handleStaleSession(error)) return;
        const message = error instanceof ApiError && error.code === "FILE_EDIT_LEASE_LOST"
          ? "Your edit lease expired or was lost. Your text is preserved read-only; reload the file before editing again."
          : "The edit lease could not be refreshed. Editing was stopped to protect this file.";
        releaseFileLease(fileEditLease);
        setFileEditMode(false);
        setFileEditLease(null);
        setFileLeaseMessage(message);
        notify("error", message);
      } finally {
        pending = false;
      }
    };
    const interval = window.setInterval(() => void heartbeat(), 20_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [fileEditLease?.leaseId, fileEditMode, activeServerIsDemo, fileSaving, scope]);

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
    requestOwnerRef.current++;
    pendingLeaseRef.current = false;
    pendingSaveRef.current = false;
    releaseFileLease();
    setDiscardEditorRequest(null);
    setSelectedPath("");
    setEditorText("");
    setSavedEditorText("");
    setFileRevision("");
    setFileEditLease(null);
    setFileEditMode(false);
    setFileLeaseBusy(false);
    setFileLeaseMessage("");
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
    if (!activeServerIsDemo && !hasFileManagerPermission(permissionUser, path, "view")) {
      const message = "View files permission is required to open this file.";
      setFileReadError(message);
      setNotice(message);
      notify("warning", message);
      return;
    }
    if (selectedPath && dirty && !discardConfirmed) {
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
    resetEditorState();
    const owner = requestOwnerRef.current;
    setSelectedPath(path);
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
      setFileOpening(false);
      return;
    }
    try {
      const file = await api<{ path: string; content: string; revision: string }>(
        `/api/servers/${activeServer.id}/file?path=${encodeURIComponent(path)}`
      );
      if (!ownsRequest(owner)) return;
      setSelectedPath(file.path);
      setEditorText(file.content);
      setSavedEditorText(file.content);
      setFileRevision(file.revision);
      setSelectedFilePaths([file.path]);
    } catch (error) {
      if (!ownsRequest(owner) || handleStaleSession(error)) return;
      const message = errorMessage(error, "Could not read this file. Check that the path is available and editable.");
      setFileReadError(message);
      setFileOpenFailed(true);
      setSelectedFilePaths([]);
      notify("error", message);
    } finally {
      if (ownsRequest(owner)) setFileOpening(false);
    }
  }

  async function enterFileEditMode() {
    if (!activeServer || !selectedPath || !fileRevision || fileEditMode || pendingLeaseRef.current || pendingSaveRef.current || fileLeaseBusy || fileOpening || fileOpenFailed) return;
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
    const owner = requestOwnerRef.current;
    pendingLeaseRef.current = true;
    setFileLeaseBusy(true);
    setFileLeaseMessage("");
    try {
      const result = await api<{ lease: FileEditLease }>(`/api/servers/${activeServer.id}/file/lease`, {
        method: "POST",
        body: JSON.stringify({ path: selectedPath, revision: fileRevision })
      });
      if (!ownsRequest(owner)) {
        releaseFileLease(result.lease);
        return;
      }
      setFileEditLease(result.lease);
      setFileEditMode(true);
    } catch (error) {
      if (!ownsRequest(owner) || handleStaleSession(error)) return;
      const message = error instanceof ApiError && error.code === "FILE_REVISION_CONFLICT"
        ? "This file changed since it was opened. Reload it before entering edit mode."
        : fileLeaseConflictMessage(error, formatDisplayDate);
      setFileLeaseMessage(message);
      notify("warning", message);
    } finally {
      if (ownsRequest(owner)) {
        pendingLeaseRef.current = false;
        setFileLeaseBusy(false);
      }
    }
  }

  async function saveFile() {
    if (isProvisioning || dockerOperationalLock || !canEditSelectedPath || !activeServer) return;
    if (!selectedPath || !dirty) return;
    if (!fileEditMode || (!activeServerIsDemo && !fileEditLease) || fileSaving || pendingSaveRef.current) return;
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
      setNotice(`Saved ${selectedPath}`);
      notify("success", `Saved ${selectedPath}`);
      setListing(demoFixtures().demoListing(listing.path, nextFiles, demoInstalledMods));
      setFileSaving(false);
      return;
    }
    const owner = requestOwnerRef.current;
    const savedText = editorText;
    pendingSaveRef.current = true;
    try {
      const result = await api<{ revision: string }>(`/api/servers/${activeServer.id}/file`, {
        method: "PUT",
        body: JSON.stringify({
          path: selectedPath,
          content: savedText,
          leaseId: fileEditLease?.leaseId,
          revision: fileRevision
        })
      });
      if (!ownsRequest(owner)) return;
      setSavedEditorText(savedText);
      setFileRevision(result.revision);
      // Successful writes consume the backend lease; keep newer text, but
      // require a fresh lease against this revision before editing again.
      setFileEditLease(null);
      setFileEditMode(false);
      setNotice(`Saved ${selectedPath}`);
      notify("success", `Saved ${selectedPath}`);
      await refreshFiles(activeServer.id, listing.path);
    } catch (error) {
      if (!ownsRequest(owner) || handleStaleSession(error)) return;
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
      if (ownsRequest(owner)) {
        pendingSaveRef.current = false;
        setFileSaving(false);
      }
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
      setSelectedPath: (path: string) => { void openFile(path, true); },
      setEditorText,
      setFileReadError,
      setDiscardEditorRequest
    }
  };
}
