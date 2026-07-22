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
  expiresAt?: string;
  expiredAt?: string;
};

export type ExportOperationResult = {
  artifact?: ExportArtifactMetadata;
  artifactPath?: string;
  serverIds?: string[];
  includeInstance?: boolean;
  [key: string]: unknown;
};

export type ExportMaintenanceReport = {
  expiredArtifacts: number;
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

export function exportArtifactExpiresAt(operation: OperationRecord, retentionMs: number) {
  const artifact = objectValue(exportOperationResult(operation).artifact) as ExportArtifactMetadata | undefined;
  const explicit = artifact?.expiresAt ? Date.parse(artifact.expiresAt) : Number.NaN;
  if (Number.isFinite(explicit)) return explicit;
  const completedAt = Date.parse(operation.finishedAt ?? operation.createdAt);
  return Number.isFinite(completedAt) ? completedAt + retentionMs : undefined;
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
    private readonly retentionMs: number,
    private readonly operationRetentionMs: number,
    private readonly operationRetentionMaxRows: number
  ) {}

  async maintain(now = Date.now()): Promise<ExportMaintenanceReport> {
    const report: ExportMaintenanceReport = {
      expiredArtifacts: 0,
      abandonedArtifacts: 0,
      orphanedArtifacts: 0,
      prunedOperations: 0,
      failures: []
    };
    const referenced = new Set<string>();
    const activePrefixes: string[] = [];

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
        const cleanup = await this.removeOperationFiles(operation, report);
        report.abandonedArtifacts += cleanup.removed;
        continue;
      }
      const expiresAt = exportArtifactExpiresAt(operation, this.retentionMs);
      if (expiresAt !== undefined && expiresAt <= now) {
        const artifact = objectValue(exportOperationResult(operation).artifact) as ExportArtifactMetadata | undefined;
        const wasExpired = Boolean(artifact?.expiredAt && !exportOperationResult(operation).artifactPath);
        if (await this.expireOperation(operation, now, report)) {
          if (!wasExpired) report.expiredArtifacts += 1;
        } else this.referenceOperationFiles(operation, referenced);
      } else {
        this.ensureExplicitExpiry(operation, expiresAt);
        this.referenceOperationFiles(operation, referenced);
      }
    }

    let entries: Dirent[];
    try {
      entries = await readdir(this.exportsDir, { withFileTypes: true });
    } catch (error) {
      report.failures.push({ path: this.exportsDir, message: errorMessage(error) });
      entries = [];
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
      if (operation.type !== "export.run" || (await this.removeOperationFiles(operation, report)).success) {
        deletable.push(operation.id);
      }
    }
    report.prunedOperations = this.operations.deleteFinished(deletable);
    return report;
  }

  async cleanupSettledOperation(operation: OperationRecord) {
    if (operation.type !== "export.run" || operation.status === "succeeded") return true;
    return (await this.removeOperationFiles(operation)).success;
  }

  async expireOperation(operation: OperationRecord, now = Date.now(), report?: ExportMaintenanceReport) {
    const cleanup = await this.removeOperationFiles(operation, report);
    if (!cleanup.success) return false;
    const result = exportOperationResult(operation);
    const artifact = objectValue(result.artifact) as ExportArtifactMetadata | undefined ?? {};
    if (artifact.expiredAt && !result.artifactPath) return true;
    const expiresAt = exportArtifactExpiresAt(operation, this.retentionMs) ?? now;
    const { artifactPath: _artifactPath, ...retainedResult } = result;
    const { downloadUrl: _downloadUrl, ...retainedArtifact } = artifact;
    this.operations.replaceResult(operation.id, {
      ...retainedResult,
      artifact: {
        ...retainedArtifact,
        expiresAt: new Date(expiresAt).toISOString(),
        expiredAt: new Date(now).toISOString()
      }
    });
    return true;
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

  private ensureExplicitExpiry(operation: OperationRecord, expiresAt: number | undefined) {
    if (expiresAt === undefined) return;
    const result = exportOperationResult(operation);
    const artifact = objectValue(result.artifact) as ExportArtifactMetadata | undefined ?? {};
    if (artifact.expiresAt && Number.isFinite(Date.parse(artifact.expiresAt))) return;
    this.operations.replaceResult(operation.id, {
      ...result,
      artifact: { ...artifact, expiresAt: new Date(expiresAt).toISOString() }
    });
  }

  private async removeOperationFiles(operation: OperationRecord, report?: ExportMaintenanceReport) {
    const paths = new Set([this.canonicalPath(operation.id)]);
    const storedPath = this.storedPath(operation);
    if (storedPath) paths.add(storedPath);
    try {
      const entries = await readdir(this.exportsDir, { withFileTypes: true });
      const temporaryPrefix = `${exportArtifactFilename(operation.id)}.`;
      for (const entry of entries) {
        if (entry.isFile() && entry.name.startsWith(temporaryPrefix) && entry.name.endsWith(".tmp")) {
          paths.add(resolve(this.exportsDir, entry.name));
        }
      }
    } catch (error) {
      report?.failures.push({ operationId: operation.id, path: this.exportsDir, message: errorMessage(error) });
      return { success: false, removed: 0 };
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
