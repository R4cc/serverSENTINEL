import { statfs } from "node:fs/promises";
import { join } from "node:path";
import type { ExportSelection, ExportSizeEstimate, ExportSizeServerEstimate } from "@serversentinel/contracts";
import { services, runtimeForServer } from "../appServices.js";
import { appVersion } from "../buildInfo.js";
import { config } from "../config.js";
import { errorLogFields, logError, logWarn } from "../logging.js";
import { validateServerId } from "../http/validation.js";
import { asArray } from "../storage/valueValidation.js";
import { listManagedServers } from "../servers/store.js";
import { collectServerCategories } from "../servers/exportSelection.js";
import { restoreLockfileContent } from "../servers/importContent.js";
import { runtimeRunning } from "../mods/modService.js";
import { localNodeId } from "../nodes/nodeService.js";
import {
  applyImportArchive,
  createExportPlan,
  exportArtifactFilename,
  readExportManifest,
  validateImportArchive,
  writeExportArchive
} from "../importExport.js";
import type { ManagedServer } from "../types.js";

export function selectedExportServerIds(value: unknown) {
  if (value === undefined) return undefined;
  return asArray(value, "serverIds").map((id) => validateServerId(id));
}

export function targetNodeIdFromBody(value: unknown) {
  const targetNodeId = typeof value === "string" ? value.trim() : "";
  if (!targetNodeId) {
    throw new Error("targetNodeId is required");
  }
  return targetNodeId;
}

export async function resolveExportServers(serverIds: string[] | undefined) {
  const all = await listManagedServers();
  if (serverIds === undefined) return all;
  const selected = new Set(serverIds);
  const servers = all.filter((server) => selected.has(server.id));
  if (servers.length !== selected.size) {
    throw new Error("One or more selected servers could not be found");
  }
  return servers;
}

async function serverIsRunning(server: ManagedServer) {
  try {
    return runtimeRunning(await runtimeForServer(server).serverStatus(server)) === true;
  } catch {
    // A node that cannot answer cannot prove the server is stopped, so treat it as unsafe to export.
    return true;
  }
}

/**
 * A world copied out from under a running server is a torn snapshot: region files are rewritten in
 * place while chunks are saved, so the archive can contain half-written chunks that roll back or
 * corrupt on restore. Rather than warn, exports require every selected server to be stopped.
 */
export async function assertServersStopped(servers: ManagedServer[]) {
  const running: string[] = [];
  for (const server of servers) {
    if (await serverIsRunning(server)) running.push(server.displayName);
  }
  if (running.length) {
    throw new Error(`Stop ${running.join(", ")} before exporting. A server that is running cannot produce a consistent copy of its world.`);
  }
}

async function availableBytes(path: string) {
  try {
    const stats = await statfs(path);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // Not every platform and filesystem reports this; the precheck degrades to "unknown".
    return undefined;
  }
}

export async function estimateExport(serverIds: string[] | undefined, selection: ExportSelection): Promise<ExportSizeEstimate> {
  const servers = await resolveExportServers(serverIds);
  const estimates: ExportSizeServerEstimate[] = [];
  let totalBytes = 0;
  for (const server of servers) {
    const collected = await collectServerCategories(runtimeForServer(server), server, selection.categories);
    const categories = collected.map((entry) => ({
      category: entry.category,
      bytes: entry.totalBytes,
      fileCount: entry.files.length
    }));
    const serverTotal = categories.reduce((total, entry) => total + entry.bytes, 0);
    totalBytes += serverTotal;
    estimates.push({
      serverId: server.id,
      displayName: server.displayName,
      running: await serverIsRunning(server),
      categories,
      totalBytes: serverTotal
    });
  }
  return { servers: estimates, totalBytes, availableBytes: await availableBytes(config.exportsDir) };
}

/**
 * Compression means the artifact is smaller than the raw selection, so this is deliberately
 * pessimistic: it refuses only when even an uncompressed copy plus the configured headroom would not
 * fit. A false pass still fails cleanly on ENOSPC while writing.
 */
export async function assertExportDiskSpace(estimatedBytes: number) {
  const free = await availableBytes(config.exportsDir);
  if (free === undefined) return;
  if (free < estimatedBytes + config.exportMinFreeBytes) {
    const needed = Math.ceil((estimatedBytes + config.exportMinFreeBytes) / 1024 / 1024);
    const have = Math.floor(free / 1024 / 1024);
    throw new Error(`Not enough free space for this export: about ${needed} MiB is needed and ${have} MiB is available. Deselect the world, or free up space.`);
  }
}

export function startExportOperation(input: { serverIds?: string[]; selection: ExportSelection }, createdBy: string) {
  return services.operationService.enqueue<{
    written: Awaited<ReturnType<typeof writeExportArchive>>;
    plan: Awaited<ReturnType<typeof createExportPlan>>;
    operationId: string;
  }>({
    type: "export.run",
    createdBy,
    task: "Queued export",
    runningTask: "Preparing export",
    successTask: "Export ready",
    failureTask: "Export failed",
    failureFallback: "Export failed",
    result: ({ written, plan, operationId }) => ({
      artifact: {
        filename: written.filename,
        size: written.size,
        sha256: written.sha256,
        downloadUrl: `/api/exports/${operationId}/download`,
        expiresAt: new Date(Date.now() + config.exportRetentionMs).toISOString()
      },
      artifactPath: written.path,
      serverIds: plan.manifest.servers.map((entry) => entry.server.id),
      selection: plan.manifest.manifest.selection,
      serverCount: plan.manifest.servers.length,
      serverFileCount: plan.manifest.manifest.content.files,
      uncompressedBytes: plan.totalBytes,
      warnings: plan.manifest.warnings
    }),
    onError: (error, operation) => {
      logError({ operationId: operation.id, action: "export", status: "failed", ...errorLogFields(error) }, "Export operation failed");
    },
    onSettled: async (operation) => {
      if (!await services.exportArtifactMaintenance.cleanupSettledOperation(operation)) {
        logWarn({ operationId: operation.id, status: operation.status }, "Could not clean up an incomplete export artifact; periodic maintenance will retry");
      }
    }
  }, async (operation, report) => {
    const servers = await resolveExportServers(input.serverIds);
    // Re-checked inside the operation: the request may have queued behind other work, and a server
    // that was stopped when the operator clicked export can be running by the time it runs.
    await assertServersStopped(servers);
    const plan = await createExportPlan({
      appVersion,
      servers,
      selection: input.selection,
      runtimeForServer,
      modPreferencesForServer: (serverId) => services.modPreferencesRepository.list(serverId),
      report
    });
    await assertExportDiskSpace(plan.totalBytes);
    const written = await writeExportArchive(join(config.exportsDir, exportArtifactFilename(operation.id)), plan, report);
    return { written, plan, operationId: operation.id };
  });
}

export async function validateImportArchiveFile(archivePath: string, targetNodeId: string) {
  const manifest = await readExportManifest(archivePath);
  return {
    manifest: manifest.manifest,
    ...validateImportArchive(manifest, {
      targetNodeId,
      localNodeId,
      existingServers: await listManagedServers(),
      serversDir: config.serversDir,
      tmpDir: config.tmpDir
    })
  };
}

export function startImportOperation(input: { archivePath: string; targetNodeId: string }, createdBy: string) {
  return services.operationService.enqueue({
    type: "import.run",
    nodeId: input.targetNodeId,
    createdBy,
    task: "Queued import",
    runningTask: "Validating import",
    successTask: "Import complete",
    failureTask: "Import failed",
    failureFallback: "Import failed",
    onError: (error, operation) => {
      logError({ operationId: operation.id, action: "import", status: "failed", ...errorLogFields(error) }, "Import operation failed");
    }
  }, async (_operation, report) => {
    const manifest = await readExportManifest(input.archivePath);
    return applyImportArchive(input.archivePath, manifest, {
      targetNodeId: input.targetNodeId,
      localNodeId,
      existingServers: await listManagedServers(),
      serversDir: config.serversDir,
      tmpDir: config.tmpDir,
      storage: services.storageDatabase,
      serversRepository: services.serversRepository,
      modPreferencesRepository: services.modPreferencesRepository,
      restoreContent: (server, lockfile) => restoreLockfileContent(runtimeForServer(server), server, lockfile),
      report
    });
  });
}
