import { useCallback, useEffect, useRef, useState } from "react";
import {
  EXPORT_DEFAULT_CATEGORIES,
  type ExportCategory,
  type ExportContentStrategy,
  type ExportSizeEstimate,
  type ImportValidationResult
} from "@serversentinel/contracts";
import { api, ApiError, exportConflictEvent } from "../../api";
import { errorMessage } from "../../utils/appHelpers";
import type { OperationRecord } from "../../types";

export type ServerExportArtifact = {
  operationId: string;
  filename: string;
  size?: number;
  createdAt: string;
  downloadUrl?: string;
};

export type ServerExportTask = Pick<OperationRecord,
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
};

const pollIntervalMs = 1000;

export function exportStatePollInterval(state: ServerExportState) {
  return state.latest?.status === "queued" || state.latest?.status === "running" ? pollIntervalMs : 5_000;
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
  enabled = true
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
  const [serverExportState, setServerExportState] = useState<ServerExportState>({ latest: null, artifact: null });
  const [serverExportStateLoading, setServerExportStateLoading] = useState(false);
  const [serverExportStateError, setServerExportStateError] = useState("");

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

  const refreshServerExportState = useCallback(async (serverId = activeServerId) => {
    if (!enabled || !serverId) {
      setServerExportState({ latest: null, artifact: null });
      setServerExportStateError("");
      return;
    }
    const requestId = exportStateRequestRef.current + 1;
    exportStateRequestRef.current = requestId;
    setServerExportStateLoading(true);
    try {
      const next = await api<ServerExportState>(`/api/servers/${encodeURIComponent(serverId)}/exports`);
      if (exportStateRequestRef.current === requestId) {
        setServerExportState(next);
        setServerExportStateError("");
      }
    } catch (error) {
      if (exportStateRequestRef.current === requestId) {
        setServerExportStateError(errorMessage(error, "Export status is temporarily unavailable."));
      }
    } finally {
      if (exportStateRequestRef.current === requestId) setServerExportStateLoading(false);
    }
  }, [activeServerId, enabled]);

  useEffect(() => {
    void refreshServerExportState();
  }, [refreshServerExportState]);

  useEffect(() => {
    if (!enabled || !activeServerId) return;
    const timer = window.setTimeout(() => void refreshServerExportState(), exportStatePollInterval(serverExportState));
    return () => window.clearTimeout(timer);
  }, [activeServerId, enabled, refreshServerExportState, serverExportState]);

  useEffect(() => {
    if (!enabled || !activeServerId) return;
    const refresh = () => void refreshServerExportState();
    window.addEventListener("focus", refresh);
    window.addEventListener(exportConflictEvent, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
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
    setExportBusy(true);
    setExportError("");
    try {
      const operation = await api<OperationRecord>("/api/exports", {
        method: "POST",
        body: JSON.stringify({
          serverIds: [exportServerId],
          selection: { categories, contentStrategy }
        })
      });
      setServerExportState((current) => ({
        ...current,
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
      }));
      setExportOpen(false);
      setCategories([...EXPORT_DEFAULT_CATEGORIES]);
      setContentStrategy("lockfile");
      setEstimate(null);
      notify("info", "Export started in the background.");
      void refreshServerExportState(exportServerId);
    } catch (error) {
      setExportError(errorMessage(error, "The export could not be started."));
    } finally {
      setExportBusy(false);
    }
  }, [categories, contentStrategy, exportServerId, notify, refreshServerExportState]);

  const cancelExport = useCallback(async (operationId: string) => {
    try {
      await api<OperationRecord>(`/api/operations/${operationId}/cancel`, { method: "POST" });
      notify("info", "Cancelling export…");
    } catch (error) {
      notify("error", errorMessage(error, "The export could not be cancelled."));
    } finally {
      await refreshServerExportState();
    }
  }, [notify, refreshServerExportState]);

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
    setImportTask("Uploading archive");
    try {
      const body = new FormData();
      body.append("file", file);
      const uploaded = await api<{ importId: string }>("/api/imports/upload", { method: "POST", body });
      setImportId(uploaded.importId);
      setImportTask("Validating archive");
      const validation = await api<ImportValidationResult>("/api/imports/validate", {
        method: "POST",
        body: JSON.stringify({ importId: uploaded.importId, targetNodeId })
      });
      setImportValidation(validation);
    } catch (error) {
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
      // A missing runtime jar leaves a server that cannot start at all, so it outranks content that
      // merely failed to come back.
      if (jarFailures.length) {
        notify("error", `Imported, but the runtime could not be downloaded for ${jarFailures.map((failure) => failure.serverName).join(", ")}. Re-save the server's runtime settings to retry.`);
      } else if (contentFailures.length) {
        notify("info", `Imported with ${contentFailures.length} mod/plugin file(s) that could not be re-downloaded.`);
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
