import { useCallback, useRef, useState } from "react";
import {
  EXPORT_DEFAULT_CATEGORIES,
  type ExportCategory,
  type ExportContentStrategy,
  type ExportSizeEstimate,
  type ImportValidationResult
} from "@serversentinel/contracts";
import { api, ApiError } from "../../api";
import { errorMessage } from "../../utils/appHelpers";
import type { OperationRecord } from "../../types";

export type ExportArtifactResult = {
  filename: string;
  size: number;
  downloadUrl: string;
  expiresAt: string;
};

type ExportOperationResult = {
  artifact?: ExportArtifactResult;
  warnings?: string[];
};

type ImportOperationResult = {
  imported?: Array<{ serverId: string; displayName: string }>;
  contentFailures?: Array<{ serverName: string; filename: string; reason: string }>;
  runtimeJarFailures?: Array<{ serverName: string; reason: string }>;
};

const pollIntervalMs = 1000;

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

export function useExportWorkspace(notify: (tone: "success" | "error" | "info", text: string) => void) {
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const [categories, setCategories] = useState<ExportCategory[]>([...EXPORT_DEFAULT_CATEGORIES]);
  const [contentStrategy, setContentStrategy] = useState<ExportContentStrategy>("lockfile");
  // Export is scoped to one server, opened from that server's properties page.
  const [exportServerId, setExportServerId] = useState("");
  const [estimate, setEstimate] = useState<ExportSizeEstimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportTask, setExportTask] = useState("");
  const [exportProgress, setExportProgress] = useState(0);
  const [artifact, setArtifact] = useState<ExportArtifactResult | null>(null);
  const [exportWarnings, setExportWarnings] = useState<string[]>([]);
  const [exportError, setExportError] = useState("");

  const [importFile, setImportFile] = useState<File | null>(null);
  const [importId, setImportId] = useState("");
  const [importTargetNodeId, setImportTargetNodeId] = useState("");
  const [importValidation, setImportValidation] = useState<ImportValidationResult | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importTask, setImportTask] = useState("");
  const [importProgress, setImportProgress] = useState(0);
  const [importError, setImportError] = useState("");

  const estimateRequestRef = useRef(0);

  const refreshEstimate = useCallback(async (nextCategories: ExportCategory[], serverId: string) => {
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
          selection: { categories: nextCategories, contentStrategy }
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
  }, [contentStrategy]);

  const openExport = useCallback((serverId: string) => {
    setExportServerId(serverId);
    setArtifact(null);
    setExportWarnings([]);
    setExportError("");
    setExportProgress(0);
    setExportTask("");
    setExportOpen(true);
    void refreshEstimate(categories, serverId);
  }, [categories, refreshEstimate]);

  const closeExport = useCallback(() => {
    if (exportBusy) return;
    setExportOpen(false);
  }, [exportBusy]);

  const runExport = useCallback(async () => {
    setExportBusy(true);
    setExportError("");
    setArtifact(null);
    setExportProgress(0);
    setExportTask("Queued export");
    try {
      const operation = await api<OperationRecord>("/api/exports", {
        method: "POST",
        body: JSON.stringify({
          serverIds: [exportServerId],
          selection: { categories, contentStrategy }
        })
      });
      const finished = await pollOperation(operation.id, (current) => {
        setExportProgress(current.progress ?? 0);
        setExportTask(current.task ?? "");
      });
      const result = (finished.result ?? {}) as ExportOperationResult;
      setExportWarnings(result.warnings ?? []);
      if (!result.artifact) throw new Error("The export finished without producing a download.");
      setArtifact(result.artifact);
      notify("success", "Export ready to download.");
    } catch (error) {
      setExportError(errorMessage(error, "The export failed."));
    } finally {
      setExportBusy(false);
    }
  }, [categories, contentStrategy, exportServerId, notify]);

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
    exportTask,
    exportProgress,
    artifact,
    exportWarnings,
    exportError,
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
    openImport,
    closeImport,
    uploadAndValidate,
    runImport,
    setImportFile,
    setImportTargetNodeId,
    setContentStrategy: (strategy: ExportContentStrategy) => {
      setContentStrategy(strategy);
      void refreshEstimate(categories, exportServerId);
    },
    toggleCategory: (category: ExportCategory) => {
      const next = categories.includes(category)
        ? categories.filter((entry) => entry !== category)
        : [...categories, category];
      setCategories(next);
      void refreshEstimate(next, exportServerId);
    }
  };
}

export type ExportWorkspace = ReturnType<typeof useExportWorkspace>;
