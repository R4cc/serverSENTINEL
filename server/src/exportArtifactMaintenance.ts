import type { Dirent } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { OperationRecord } from "./types.js";
import { exportArtifactFilename } from "./importExport.js";
import type { OperationsRepository } from "./storage/operationsRepository.js";

type ExportArtifactMetadata = {
  filename?: string;
  size?: number;
  sha256?: string;
  downloadUrl?: string;
};

export type ExportOperationResult = {
  artifact?: ExportArtifactMetadata;
  artifactPath?: string;
  serverIds?: string[];
  selection?: { categories?: string[]; contentStrategy?: string };
  [key: string]: unknown;
};

export type ExportMaintenanceReport = {
  abandonedArtifacts: number;
  orphanedArtifacts: number;
  prunedOperations: number;
  failures: Array<{ path?: string; operationId?: string; message: string }>;
};

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function exportOperationResult(operation: OperationRecord): ExportOperationResult {
  return objectValue(operation.result) as ExportOperationResult | undefined ?? {};
}

export function exportOperationServerIds(operation: OperationRecord) {
  const serverIds = exportOperationResult(operation).serverIds;
  return Array.isArray(serverIds)
    ? serverIds.filter((serverId): serverId is string => typeof serverId === "string")
    : operation.serverId ? [operation.serverId] : [];
}

function overlapsServerIds(operation: OperationRecord, serverIds: ReadonlySet<string>) {
  return exportOperationServerIds(operation).some((serverId) => serverIds.has(serverId));
}

function insideDirectory(root: string, path: string) {
  const contained = relative(resolve(root), resolve(path));
  return contained !== ""
    && contained !== ".."
    && !contained.startsWith(`..${sep}`)
    && !isAbsolute(contained);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class ExportArtifactMaintenance {
  constructor(
    private readonly exportsDir: string,
    private readonly operations: OperationsRepository,
    private readonly operationRetentionMs: number,
    private readonly operationRetentionMaxRows: number
  ) {}

  async maintain(now = Date.now()): Promise<ExportMaintenanceReport> {
    const report: ExportMaintenanceReport = {
      abandonedArtifacts: 0,
      orphanedArtifacts: 0,
      prunedOperations: 0,
      failures: []
    };
    const referenced = new Set<string>();
    const activePrefixes: string[] = [];
    const retainedServerIds = new Set<string>();
    const supersededSuccessIds: string[] = [];

    // One directory read for the whole pass. Every export operation used to trigger its own
    // `readdir` of this directory to find leftover `.tmp` siblings, so a fleet with a few hundred
    // retained exports scanned the same directory a few hundred times per maintenance run.
    let entries: Dirent[] = [];
    let directoryError: unknown;
    try {
      entries = await readdir(this.exportsDir, { withFileTypes: true });
    } catch (error) {
      directoryError = error;
    }
    const fileNames = directoryError === undefined ? entries.filter((entry) => entry.isFile()).map((entry) => entry.name) : undefined;

    for (const operation of this.operations.listExportOperations()) {
      if (operation.status === "queued" || operation.status === "running") {
        const canonical = this.canonicalPath(operation.id);
        referenced.add(canonical);
        activePrefixes.push(`${canonical}.`);
        const storedPath = this.storedPath(operation);
        if (storedPath) referenced.add(storedPath);
        continue;
      }
      if (operation.status === "failed" || operation.status === "cancelled") {
        const cleanup = await this.removeOperationFiles(operation, report, fileNames);
        report.abandonedArtifacts += cleanup.removed;
        continue;
      }
      // The newest successful artifact is retained until another successful export replaces it.
      // Nothing expires the only available download merely because time passed.
      const serverIds = exportOperationServerIds(operation);
      if (
        typeof exportOperationResult(operation).artifactPath === "string"
        && serverIds.some((serverId) => retainedServerIds.has(serverId))
      ) {
        const cleanup = await this.removeOperationFiles(operation, report, fileNames);
        if (cleanup.success) {
          supersededSuccessIds.push(operation.id);
          continue;
        }
      }
      this.referenceOperationFiles(operation, referenced);
      for (const serverId of serverIds) retainedServerIds.add(serverId);
    }

    if (directoryError !== undefined) {
      report.failures.push({ path: this.exportsDir, message: errorMessage(directoryError) });
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = resolve(this.exportsDir, entry.name);
      if (referenced.has(path) || activePrefixes.some((prefix) => path.startsWith(prefix))) continue;
      try {
        if (await this.removeFile(path)) report.orphanedArtifacts += 1;
      } catch (error) {
        report.failures.push({ path, message: errorMessage(error) });
      }
    }

    const cutoff = new Date(now - this.operationRetentionMs).toISOString();
    const candidates = new Map([
      ...this.operations.listFinishedBefore(cutoff),
      ...this.operations.listFinishedBeyondLimit(this.operationRetentionMaxRows)
    ].map((operation) => [operation.id, operation]));
    const deletable: string[] = [];
    for (const operation of candidates.values()) {
      const retainedExport = operation.type === "export.run"
        && operation.status === "succeeded"
        && typeof exportOperationResult(operation).artifactPath === "string";
      if (retainedExport) continue;
      if (operation.type !== "export.run" || (await this.removeOperationFiles(operation, report, fileNames)).success) {
        deletable.push(operation.id);
      }
    }
    report.prunedOperations = this.operations.deleteFinished([...supersededSuccessIds, ...deletable]);
    return report;
  }

  async cleanupSettledOperation(operation: OperationRecord) {
    if (operation.type !== "export.run" || operation.status === "succeeded") return true;
    return (await this.removeOperationFiles(operation)).success;
  }

  async cleanupOperationArtifacts(operation: OperationRecord) {
    return (await this.removeOperationFiles(operation)).success;
  }

  async prepareNewExport(serverIds: readonly string[]) {
    const scope = new Set(serverIds);
    const obsolete = this.operations.listExportOperations().filter((operation) => (
      operation.status !== "queued"
      && operation.status !== "running"
      && overlapsServerIds(operation, scope)
      && !(operation.status === "succeeded" && typeof exportOperationResult(operation).artifactPath === "string")
    ));
    const deletable: string[] = [];
    for (const operation of obsolete) {
      if ((await this.removeOperationFiles(operation)).success) deletable.push(operation.id);
    }
    this.operations.deleteFinished(deletable);
  }

  async replacePreviousSuccessfulExports(operationId: string, serverIds: readonly string[]) {
    const scope = new Set(serverIds);
    const previous = this.operations.listExportOperations().filter((operation) => (
      operation.id !== operationId
      && operation.status === "succeeded"
      && overlapsServerIds(operation, scope)
    ));
    const deletable: string[] = [];
    for (const operation of previous) {
      const cleanup = await this.removeOperationFiles(operation);
      if (!cleanup.success) throw new Error("The previous export could not be removed; retry the export after checking panel storage permissions");
      deletable.push(operation.id);
    }
    this.operations.deleteFinished(deletable);
  }

  private canonicalPath(operationId: string) {
    return resolve(this.exportsDir, exportArtifactFilename(operationId));
  }

  private storedPath(operation: OperationRecord) {
    const value = exportOperationResult(operation).artifactPath;
    return typeof value === "string" && insideDirectory(this.exportsDir, value) ? resolve(value) : undefined;
  }

  private referenceOperationFiles(operation: OperationRecord, referenced: Set<string>) {
    referenced.add(this.canonicalPath(operation.id));
    const storedPath = this.storedPath(operation);
    if (storedPath) referenced.add(storedPath);
  }

  /**
   * `directoryFileNames` is the caller's already-read listing of `exportsDir`. A maintenance pass
   * hands the same snapshot to every operation instead of re-reading the directory per operation;
   * callers without one still read it themselves.
   */
  private async removeOperationFiles(operation: OperationRecord, report?: ExportMaintenanceReport, directoryFileNames?: string[]) {
    const paths = new Set([this.canonicalPath(operation.id)]);
    const storedPath = this.storedPath(operation);
    if (storedPath) paths.add(storedPath);
    let names = directoryFileNames;
    if (!names) {
      try {
        names = (await readdir(this.exportsDir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
      } catch (error) {
        report?.failures.push({ operationId: operation.id, path: this.exportsDir, message: errorMessage(error) });
        return { success: false, removed: 0 };
      }
    }
    const temporaryPrefix = `${exportArtifactFilename(operation.id)}.`;
    for (const name of names) {
      if (name.startsWith(temporaryPrefix) && name.endsWith(".tmp")) {
        paths.add(resolve(this.exportsDir, name));
      }
    }
    let succeeded = true;
    let removed = 0;
    for (const path of paths) {
      try {
        if (await this.removeFile(path)) removed += 1;
      } catch (error) {
        succeeded = false;
        report?.failures.push({ operationId: operation.id, path, message: errorMessage(error) });
      }
    }
    return { success: succeeded, removed };
  }

  private async removeFile(path: string) {
    try {
      await rm(path);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
