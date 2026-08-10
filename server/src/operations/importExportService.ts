import { readdir, rm, stat, statfs } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ExportSelection, ExportSizeEstimate, ExportSizeServerEstimate } from "@serversentinel/contracts";
import { services, runtimeForServer } from "../appServices.js";
import { appVersion } from "../buildInfo.js";
import { config } from "../config.js";
import { detailedErrorMessage, errorLogFields, logError, logWarn } from "../logging.js";
import { ExportCancelledError } from "../exportCoordinator.js";
import { validateServerId } from "../http/validation.js";
import { asArray } from "../storage/valueValidation.js";
import { listManagedServers } from "../servers/store.js";
import { collectServerCategories } from "../servers/exportSelection.js";
import { lockfileOmittedFilenames } from "../servers/exportContent.js";
import { restoreLockfileContent } from "../servers/importContent.js";
import { downloadServerJar } from "../servers/provisioning.js";
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
  const lockfileMode = selection.contentStrategy === "lockfile" && selection.categories.includes("content");
  let totalBytes = 0;
  for (const server of servers) {
    const collected = await collectServerCategories(runtimeForServer(server), server, selection.categories);
    // A lockfile export leaves out the jars it can name, so counting the whole content directory
    // would inflate the figure the modal shows and could trip the disk precheck on a selection that
    // actually fits.
    const omitted = lockfileMode
      ? lockfileOmittedFilenames(services.modPreferencesRepository.list(server.id))
      : new Set<string>();
    const categories = collected.map((entry) => {
      const files = entry.category === "content"
        ? entry.files.filter((file) => !omitted.has(basename(file.relativePath)))
        : entry.files;
      return {
        category: entry.category,
        bytes: files.reduce((total, file) => total + file.size, 0),
        fileCount: files.length
      };
    });
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

export async function startExportOperation(input: { serverIds?: string[]; selection: ExportSelection }, createdBy: string) {
  // Explicit ids are durable scope even when preflight later discovers a missing server. This keeps
  // expensive traversal and deterministic preflight failures in the background operation while an
  // all-server export snapshots the current ids before it is accepted.
  const serverIds = input.serverIds ?? (await resolveExportServers(undefined)).map((server) => server.id);
  services.exportCoordinator.assertCanStart(serverIds);
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
    onStarted: (operation) => {
      services.operationsRepository.update(operation.id, {
        result: { serverIds, selection: input.selection }
      });
    },
    isCancellationError: (error) => error instanceof ExportCancelledError,
    cancellationMessage: "Export cancelled by user",
    result: ({ written, plan, operationId }) => ({
      artifact: {
        filename: written.filename,
        size: written.size,
        sha256: written.sha256,
        downloadUrl: `/api/exports/${operationId}/download`
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
  }, async (operation, report) => services.exportCoordinator.run(operation.id, serverIds, async (signal, beginCommit) => {
    try {
      await services.exportArtifactMaintenance.prepareNewExport(serverIds);
      const servers = await resolveExportServers(serverIds);
      // Re-checked inside the operation: the request may have queued behind other work, and a server
      // that was stopped when the operator clicked export can be running by the time it runs.
      await assertServersStopped(servers);
      const plan = await createExportPlan({
        appVersion,
        servers,
        selection: input.selection,
        runtimeForServer,
        modPreferencesForServer: (serverId) => services.modPreferencesRepository.list(serverId),
        report,
        signal
      });
      await assertExportDiskSpace(plan.totalBytes);
      const written = await writeExportArchive(join(config.exportsDir, exportArtifactFilename(operation.id)), plan, report, signal);
      beginCommit();
      await services.exportArtifactMaintenance.replacePreviousSuccessfulExports(operation.id, serverIds);
      return { written, plan, operationId: operation.id };
    } catch (error) {
      await services.exportArtifactMaintenance.cleanupOperationArtifacts(operation);
      throw error;
    }
  }));
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
    },
    // The upload has served its purpose either way, and it is the size of a whole server. Releasing
    // it here rather than trusting the browser keeps a closed tab from stranding gigabytes on disk.
    onSettled: async () => {
      await rm(input.archivePath, { force: true }).catch((error) => {
        logWarn({ action: "import", errorDetails: detailedErrorMessage(error) }, "Could not remove an uploaded import archive; periodic maintenance will retry");
      });
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
      restoreRuntimeJar: (server) => downloadServerJar(server),
      report
    });
  });
}

/**
 * Removes uploaded archives that no import ever consumed -- a closed tab, a failed validation, or a
 * replaced file selection all leave one behind. Runs on the same tick as export artifact maintenance.
 */
export async function sweepAbandonedImports(now = Date.now(), maxAgeMs = config.importRetentionMs) {
  let entries;
  try {
    entries = await readdir(config.importsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0 };
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("import-") || !entry.name.endsWith(".zip")) continue;
    const path = resolve(config.importsDir, entry.name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs < maxAgeMs) continue;
      await rm(path, { force: true });
      removed += 1;
    } catch (error) {
      logWarn({ action: "import_sweep", path, errorDetails: detailedErrorMessage(error) }, "Could not remove an abandoned import archive");
    }
  }
  return { removed };
}
