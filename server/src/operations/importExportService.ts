import { join } from "node:path";
import { services } from "../appServices.js";
import { appVersion } from "../buildInfo.js";
import { config } from "../config.js";
import { logError, logWarn } from "../logging.js";
import { errorLogFields } from "../logging.js";
import { validateServerId } from "../http/validation.js";
import { asArray } from "../storage/valueValidation.js";
import { readNodes } from "../nodes/nodeService.js";
import { listManagedServers } from "../servers/store.js";

import { applyImportArtifact, createExportArtifact, exportArtifactFilename, parseExportArtifactBase64, writeExportArtifact } from "../importExport.js";
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

export async function startExportOperation(input: { serverIds?: string[]; includeInstance: boolean }, createdBy: string) {
  return services.operationService.enqueue<{
    artifact: Awaited<ReturnType<typeof createExportArtifact>>;
    written: Awaited<ReturnType<typeof writeExportArtifact>>;
    operationId: string;
  }>({
    type: "export.run",
    createdBy,
    task: "Queued export",
    runningTask: "Preparing export",
    successTask: "Export ready",
    failureTask: "Export failed",
    failureFallback: "Export failed",
    result: ({ artifact, written, operationId }) => ({
      artifact: {
        filename: written.filename,
        size: written.size,
        sha256: written.sha256,
        downloadUrl: `/api/exports/${operationId}/download`,
        expiresAt: new Date(Date.now() + config.exportRetentionMs).toISOString()
      },
      artifactPath: written.path,
      serverIds: artifact.servers.map((entry) => entry.server.id),
      includeInstance: input.includeInstance,
      serverCount: artifact.servers.length,
      serverFileCount: artifact.manifest.content.serverFiles
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
    const artifact = await createExportArtifact({
      appVersion,
      nodes: await readNodes(),
      servers: await listManagedServers(),
      selectedServerIds: input.serverIds,
      includeInstance: input.includeInstance,
      modPreferencesForServer: (serverId) => services.modPreferencesRepository.list(serverId),
      report
    });
    const written = await writeExportArtifact(join(config.exportsDir, exportArtifactFilename(operation.id)), artifact);
    return { artifact, written, operationId: operation.id };
  });
}

export async function startImportOperation(input: { artifactBase64: string; targetNodeId: string; importInstanceSettings: boolean }, createdBy: string) {
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
    const artifact = parseExportArtifactBase64(input.artifactBase64);
    return applyImportArtifact(artifact, {
      targetNodeId: input.targetNodeId,
      nodes: await readNodes(),
      existingServers: await listManagedServers(),
      serversDir: config.serversDir,
      tmpDir: config.tmpDir,
      storage: services.storageDatabase,
      serversRepository: services.serversRepository,
      modPreferencesRepository: services.modPreferencesRepository,
      importInstanceSettings: input.importInstanceSettings,
      report
    });
  });
}
