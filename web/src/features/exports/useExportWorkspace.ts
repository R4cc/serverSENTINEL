import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EXPORT_DEFAULT_CATEGORIES,
  type ExportCategory,
  type ExportContentStrategy,
  type ExportSizeEstimate,
  type ImportValidationResult
} from "@serversentinel/contracts";
import { api, ApiError, exportConflictEvent } from "../../api";
import type { RequestConfirmation } from "../../components/ConfirmationModal";
import { errorMessage } from "../../utils/appHelpers";
import type { OperationRecord } from "../../types";

export type ServerExportArtifact = {
  operationId: string;
  filename: string;
  size?: number;
  createdAt: string;
  downloadUrl?: string;
};

type ServerExportTask = Pick<OperationRecord,
  "id" | "status" | "progress" | "task" | "createdAt" | "startedAt" | "finishedAt" | "errorMessage"
> & {
  canCancel: boolean;
  startedByRequester?: boolean;
};

export type ServerExportState = {
  latest: ServerExportTask | null;
  artifact: ServerExportArtifact | null;
};

type ImportOperationResult = {
  imported?: Array<{ serverId: string; displayName: string }>;
  contentFailures?: Array<{ serverName: string; filename: string; reason: string }>;
  runtimeJarFailures?: Array<{ serverName: string; reason: string }>;
  warnings?: Array<{ code: string; message: string }>;
};

const emptyExportState: ServerExportState = { latest: null, artifact: null };
const pollIntervalMs = 1000;
const minimumImportUploadChunkBytes = 256 * 1024;

export function smallerImportUploadChunk(currentBytes: number) {
  if (currentBytes <= minimumImportUploadChunkBytes) return undefined;
  return Math.max(minimumImportUploadChunkBytes, Math.floor(currentBytes / 2));
}

export function exportStatePollInterval(state: ServerExportState) {
  return state.latest?.status === "queued" || state.latest?.status === "running" ? pollIntervalMs : 5_000;
}

/**
 * The payload is small and comes back in a stable shape from the same endpoint every time, so a
 * serialized comparison is enough to tell an unchanged poll result from a real one.
 */
export function sameServerExportState(left: ServerExportState, right: ServerExportState) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function exportRequestPayload(
  serverId: string,
  categories: ExportCategory[],
  contentStrategy: ExportContentStrategy,
  inventoryId?: string
) {
  return {
    serverIds: [serverId],
    selection: { categories, contentStrategy },
    ...(inventoryId ? { inventoryId } : {})
  };
}

async function pollOperation(operationId: string, onProgress: (operation: OperationRecord) => void) {
  for (;;) {
    const operation = await api<OperationRecord>(`/api/operations/${operationId}`);
    onProgress(operation);
    if (operation.status === "succeeded") return operation;
    if (operation.status === "failed" || operation.status === "cancelled") {
      throw new Error(operation.errorMessage || "The operation did not finish.");
    }
    await new Promise((resolve) => window.setTimeout(resolve, pollIntervalMs));
  }
}

export function useExportWorkspace(
  notify: (tone: "success" | "error" | "info", text: string) => void,
  activeServerId = "",
  enabled = true,
  requestConfirmation?: RequestConfirmation
) {
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const [categories, setCategories] = useState<ExportCategory[]>([...EXPORT_DEFAULT_CATEGORIES]);
  const [contentStrategy, setContentStrategy] = useState<ExportContentStrategy>("lockfile");
  // Export is scoped to one server, opened from that server's properties page.
  const [exportServerId, setExportServerId] = useState("");
  const [estimate, setEstimate] = useState<ExportSizeEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportError, setExportError] = useState("");
  // Each visit has its own identity, including A -> B -> A and disable -> enable.
  const scope = useMemo(() => ({ serverId: activeServerId, enabled }), [activeServerId, enabled]);
  const scopeRef = useRef<typeof scope | null>(scope);
  scopeRef.current = scope;
  const [exportStatus, setExportStatus] = useState({
    scope, data: emptyExportState, loading: enabled && Boolean(activeServerId), error: ""
  });
  const currentStatus = exportStatus.scope === scope && enabled && activeServerId ? exportStatus : null;
  const serverExportState = currentStatus?.data ?? emptyExportState;
  const serverExportStateLoading = enabled && Boolean(activeServerId) && (currentStatus?.loading ?? true);
  const serverExportStateError = currentStatus?.error ?? "";
  const [deletingExportId, setDeletingExportId] = useState("");

  const [importFile, setImportFile] = useState<File | null>(null);
  const [importId, setImportId] = useState("");
  const [importTargetNodeId, setImportTargetNodeId] = useState("");
  const [importValidation, setImportValidation] = useState<ImportValidationResult | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importTask, setImportTask] = useState("");
  const [importProgress, setImportProgress] = useState(0);
  const [importError, setImportError] = useState("");

  const estimateRequestRef = useRef(0);
  const exportStateRequestRef = useRef(0);

  // `background` marks the recurring poll rather than a load someone is waiting on. A background
  // refresh leaves the loading flag alone, because raising it announces a spinner every few
  // seconds for a card that is already showing the answer.
  const refreshServerExportState = useCallback(async (serverId = activeServerId, options?: { background?: boolean }) => {
    // Old mutation callbacks cannot refresh an inactive server or invalidate its replacement's read.
    if (!enabled || !serverId || scopeRef.current !== scope || serverId !== scope.serverId) return;
    const requestId = ++exportStateRequestRef.current;
    const isCurrent = () => scopeRef.current === scope && exportStateRequestRef.current === requestId;
    setExportStatus((current) => current.scope !== scope
      ? { scope, data: emptyExportState, loading: true, error: "" }
      : options?.background ? current : { ...current, loading: true });
    try {
      const next = await api<ServerExportState>(`/api/servers/${encodeURIComponent(serverId)}/exports`);
      if (isCurrent()) {
        setExportStatus((current) => current.scope === scope && !current.loading && !current.error
          && sameServerExportState(current.data, next)
          ? current : { scope, data: next, loading: false, error: "" });
      }
    } catch (error) {
      if (isCurrent()) {
        setExportStatus({ scope, data: emptyExportState, loading: false,
          error: errorMessage(error, "Export status is temporarily unavailable.") });
      }
    }
  }, [activeServerId, enabled, scope]);

  useEffect(() => {
    scopeRef.current = scope;
    setExportOpen(false);
    setExportBusy(false);
    setExportError("");
    setEstimate(null);
    setEstimating(false);
    setDeletingExportId("");
    ++estimateRequestRef.current;
    void refreshServerExportState();
    return () => { scopeRef.current = null; };
  }, [scope, refreshServerExportState]);

  // The poll reads its own cadence, so it cannot depend on the state it sets: doing that made each
  // result reschedule the effect, and it also meant the loop only survived because every response
  // arrived as a new object. Now that an unchanged payload keeps its identity, the timer has to
  // chain itself instead.
  const serverExportStateRef = useRef(serverExportState);
  serverExportStateRef.current = serverExportState;

  useEffect(() => {
    if (!enabled || !activeServerId) return;
    let timer = 0;
    let stopped = false;
    const scheduleNext = () => {
      if (stopped) return;
      timer = window.setTimeout(() => void tick(), exportStatePollInterval(serverExportStateRef.current));
    };
    const tick = async () => {
      // Nobody is watching the export card in a hidden tab, and every other poll in the app already
      // skips its work while hidden. Returning to the tab refreshes through the listeners below.
      if (!document.hidden) await refreshServerExportState(activeServerId, { background: true });
      scheduleNext();
    };
    scheduleNext();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [activeServerId, enabled, refreshServerExportState]);

  useEffect(() => {
    if (!enabled || !activeServerId) return;
    const refresh = () => void refreshServerExportState();
    // Coming back to a hidden tab has to catch up on whatever the paused poll missed.
    const refreshWhenVisible = () => {
      if (!document.hidden) refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener(exportConflictEvent, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener(exportConflictEvent, refresh);
    };
  }, [activeServerId, enabled, refreshServerExportState]);

  // Every input is passed in rather than read from state: the callers below refresh in the same tick
  // as the setState that changed the selection, so a value read here would still be the previous one
  // and the estimate would trail one click behind.
  const refreshEstimate = useCallback(async (
    nextCategories: ExportCategory[],
    serverId: string,
    nextContentStrategy: ExportContentStrategy
  ) => {
    if (!nextCategories.length || !serverId) {
      setEstimate(null);
      return;
    }
    const requestId = estimateRequestRef.current + 1;
    estimateRequestRef.current = requestId;
    setEstimating(true);
    try {
      const result = await api<ExportSizeEstimate>("/api/exports/estimate", {
        method: "POST",
        body: JSON.stringify({
          serverIds: [serverId],
          selection: { categories: nextCategories, contentStrategy: nextContentStrategy }
        })
      });
      // A slower earlier request must not overwrite a newer answer.
      if (estimateRequestRef.current === requestId) setEstimate(result);
    } catch (error) {
      if (estimateRequestRef.current === requestId) {
        setEstimate(null);
        setExportError(errorMessage(error, "Could not estimate the export size."));
      }
    } finally {
      if (estimateRequestRef.current === requestId) setEstimating(false);
    }
  }, []);

  const openExport = useCallback((serverId: string) => {
    setExportServerId(serverId);
    setExportError("");
    setExportOpen(true);
    void refreshEstimate(categories, serverId, contentStrategy);
  }, [categories, contentStrategy, refreshEstimate]);

  const closeExport = useCallback(() => {
    if (exportBusy) return;
    setExportOpen(false);
  }, [exportBusy]);

  const runExport = useCallback(async () => {
    if (scopeRef.current !== scope || !enabled || exportServerId !== activeServerId) return;
    setExportBusy(true);
    setExportError("");
    try {
      const operation = await api<OperationRecord>("/api/exports", {
        method: "POST",
        body: JSON.stringify(exportRequestPayload(exportServerId, categories, contentStrategy, estimate?.inventoryId))
      });
      if (scopeRef.current !== scope) return;
      // A read started before this acknowledgement must not replace the new operation.
      ++exportStateRequestRef.current;
      setExportStatus((current) => ({
        scope, loading: false, error: "",
        data: {
          ...(current.scope === scope ? current.data : emptyExportState),
          latest: {
            id: operation.id,
            status: operation.status,
            progress: operation.progress,
            task: operation.task,
            createdAt: operation.createdAt,
            startedAt: operation.startedAt,
            finishedAt: operation.finishedAt,
            errorMessage: operation.errorMessage,
            startedByRequester: true,
            canCancel: true
          }
        }
      }));
      setExportOpen(false);
      setCategories([...EXPORT_DEFAULT_CATEGORIES]);
      setContentStrategy("lockfile");
      setEstimate(null);
      notify("info", "Export started in the background.");
      void refreshServerExportState(exportServerId);
    } catch (error) {
      if (scopeRef.current === scope) setExportError(errorMessage(error, "The export could not be started."));
    } finally {
      if (scopeRef.current === scope) setExportBusy(false);
    }
  }, [activeServerId, enabled, scope, categories, contentStrategy, estimate?.inventoryId, exportServerId, notify, refreshServerExportState]);

  const cancelExport = useCallback(async (operationId: string) => {
    if (scopeRef.current !== scope || !enabled) return;
    try {
      await api<OperationRecord>(`/api/operations/${operationId}/cancel`, { method: "POST" });
      if (scopeRef.current === scope) notify("info", "Cancelling export…");
    } catch (error) {
      if (scopeRef.current === scope) notify("error", errorMessage(error, "The export could not be cancelled."));
    } finally {
      await refreshServerExportState();
    }
  }, [enabled, scope, notify, refreshServerExportState]);

  const deleteExport = useCallback(async (artifact: ServerExportArtifact) => {
    if (!requestConfirmation || !enabled || scopeRef.current !== scope) return;
    const confirmed = await requestConfirmation({
      title: "Delete export?",
      description: `Permanently delete ${artifact.filename}.`,
      warning: "The ZIP archive will be removed from panel storage and cannot be downloaded again.",
      confirmLabel: "Delete export",
      variant: "critical"
    });
    if (!confirmed || scopeRef.current !== scope) return;
    setDeletingExportId(artifact.operationId);
    try {
      await api<{ ok: boolean }>(`/api/exports/${encodeURIComponent(artifact.operationId)}`, { method: "DELETE" });
      if (scopeRef.current === scope) notify("success", "Export deleted");
    } catch (error) {
      if (scopeRef.current === scope) notify("error", errorMessage(error, "The export could not be deleted."));
    } finally {
      if (scopeRef.current === scope) setDeletingExportId("");
      await refreshServerExportState();
    }
  }, [enabled, scope, notify, refreshServerExportState, requestConfirmation]);

  const openImport = useCallback((defaultNodeId: string) => {
    setImportFile(null);
    setImportId("");
    setImportValidation(null);
    setImportError("");
    setImportProgress(0);
    setImportTask("");
    setImportTargetNodeId(defaultNodeId);
    setImportOpen(true);
  }, []);

  const closeImport = useCallback(() => {
    if (importBusy) return;
    setImportOpen(false);
    // Releases the upload promptly. Maintenance also reclaims abandoned archives on its own tick, so
    // a failed delete only costs disk until then and is not worth interrupting the operator over.
    if (importId) void api(`/api/imports/${importId}`, { method: "DELETE" }).catch(() => undefined);
    setImportId("");
  }, [importBusy, importId]);

  const uploadAndValidate = useCallback(async (file: File, targetNodeId: string) => {
    setImportBusy(true);
    setImportError("");
    setImportValidation(null);
    setImportProgress(0);
    setImportTask("Uploading archive");
    let pendingImportId = "";
    let uploadComplete = false;
    try {
      const upload = await api<{ importId: string; chunkSize: number }>("/api/imports/uploads", {
        method: "POST",
        body: JSON.stringify({ size: file.size })
      });
      pendingImportId = upload.importId;
      setImportId(upload.importId);
      let chunkSize = upload.chunkSize;
      let offset = 0;
      while (offset < file.size) {
        const end = Math.min(offset + chunkSize, file.size);
        const body = new FormData();
        // Multipart fields must precede the file because the server consumes the request as a stream.
        body.append("offset", String(offset));
        body.append("file", file.slice(offset, end), file.name);
        try {
          await api<{ received: number }>(`/api/imports/${upload.importId}/chunks`, { method: "POST", body });
          offset = end;
          const progress = Math.round((offset / file.size) * 100);
          setImportProgress(progress);
          setImportTask(`Uploading archive · ${progress}%`);
        } catch (error) {
          const smallerChunk = error instanceof ApiError && error.status === 413
            ? smallerImportUploadChunk(chunkSize)
            : undefined;
          if (!smallerChunk) throw error;
          chunkSize = smallerChunk;
        }
      }
      await api(`/api/imports/${upload.importId}/complete`, {
        method: "POST",
        body: JSON.stringify({ size: file.size })
      });
      uploadComplete = true;
      setImportTask("Validating archive");
      const validation = await api<ImportValidationResult>("/api/imports/validate", {
        method: "POST",
        body: JSON.stringify({ importId: upload.importId, targetNodeId })
      });
      setImportValidation(validation);
    } catch (error) {
      if (pendingImportId && !uploadComplete) {
        void api(`/api/imports/${pendingImportId}`, { method: "DELETE" }).catch(() => undefined);
        setImportId("");
      }
      setImportError(error instanceof ApiError ? error.message : errorMessage(error, "The archive could not be read."));
    } finally {
      setImportBusy(false);
      setImportTask("");
    }
  }, []);

  const runImport = useCallback(async (onImported: () => void | Promise<void>) => {
    if (!importId) return;
    setImportBusy(true);
    setImportError("");
    setImportProgress(0);
    setImportTask("Queued import");
    try {
      const operation = await api<OperationRecord>("/api/imports/apply", {
        method: "POST",
        body: JSON.stringify({ importId, targetNodeId: importTargetNodeId })
      });
      const finished = await pollOperation(operation.id, (current) => {
        setImportProgress(current.progress ?? 0);
        setImportTask(current.task ?? "");
      });
      const result = (finished.result ?? {}) as ImportOperationResult;
      const contentFailures = result.contentFailures ?? [];
      const jarFailures = result.runtimeJarFailures ?? [];
      const portConflicts = (result.warnings ?? []).filter((warning) => warning.code === "conflicting_port");
      // A missing runtime jar leaves a server that cannot start at all, so it outranks content that
      // merely failed to come back.
      if (jarFailures.length) {
        notify("error", `Imported, but the runtime could not be downloaded for ${jarFailures.map((failure) => failure.serverName).join(", ")}. Re-save the server's runtime settings to retry.`);
      } else if (contentFailures.length) {
        notify("info", `Imported with ${contentFailures.length} mod/plugin file(s) that could not be re-downloaded.`);
      } else if (portConflicts.length) {
        notify("info", `Imported ${result.imported?.length ?? 0} server(s). Affected servers cannot start until their port conflict is resolved in Properties.`);
      } else {
        notify("success", `Imported ${result.imported?.length ?? 0} server(s).`);
      }
      setImportOpen(false);
      // The panel releases the archive when the operation settles, so there is nothing left to delete.
      setImportId("");
      await onImported();
    } catch (error) {
      setImportError(errorMessage(error, "The import failed."));
    } finally {
      setImportBusy(false);
    }
  }, [importId, importTargetNodeId, notify]);

  return {
    exportOpen,
    importOpen,
    categories,
    contentStrategy,
    exportServerId,
    estimate,
    estimating,
    exportBusy,
    exportError,
    serverExportState,
    serverExportStateLoading,
    serverExportStateError,
    deletingExportId,
    exportMutationLocked: serverExportState.latest?.status === "queued" || serverExportState.latest?.status === "running",
    exportMutationBlockedReason: "An export is in progress. Abort it or wait for it to finish before changing this server.",
    importFile,
    importId,
    importTargetNodeId,
    importValidation,
    importBusy,
    importTask,
    importProgress,
    importError,
    openExport,
    closeExport,
    runExport,
    cancelExport,
    deleteExport,
    refreshServerExportState,
    openImport,
    closeImport,
    uploadAndValidate,
    runImport,
    setImportFile,
    setImportTargetNodeId,
    setContentStrategy: (strategy: ExportContentStrategy) => {
      setContentStrategy(strategy);
      void refreshEstimate(categories, exportServerId, strategy);
    },
    toggleCategory: (category: ExportCategory) => {
      const next = categories.includes(category)
        ? categories.filter((entry) => entry !== category)
        : [...categories, category];
      setCategories(next);
      void refreshEstimate(next, exportServerId, contentStrategy);
    }
  };
}

export type ExportWorkspace = ReturnType<typeof useExportWorkspace>;
