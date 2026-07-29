import type { FastifyInstance } from "fastify";

import { stat } from "node:fs/promises";
import { config } from "../config.js";
import { destructiveRateLimit } from "../http/rateLimits.js";
import { requireRequestPermission } from "../auth/sessionService.js";
import { selectedExportServerIds, startExportOperation, startImportOperation, targetNodeIdFromBody } from "../operations/importExportService.js";
import { assertInstanceExportAllowed, selectedExportServerIdsOrAll } from "../exportAuthorization.js";
import { exportArtifactExpiresAt, exportOperationResult } from "../exportArtifactMaintenance.js";
import { exportArtifactFilename, exportDownloadStream, parseExportArtifactBase64, validateImportArtifact } from "../importExport.js";
import { optionalStrictBoolean, validateOperationId } from "../http/validation.js";
import { apiErrorResponse } from "../http/errors.js";
import { isInsideServersDirectory } from "../storage/serverIdentity.js";
import { services } from "../appServices.js";
import { readNodes } from "../nodes/nodeService.js";
import { listManagedServers } from "../servers/store.js";
import { detailedErrorMessage, logWarn } from "../logging.js";

export function registerImportExportRoutes(app: FastifyInstance) {
app.post<{ Body: { serverIds?: unknown; includeInstance?: unknown } }>("/api/exports", destructiveRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.export");
  const includeInstance = optionalStrictBoolean(request.body?.includeInstance, "includeInstance", false);
  if (includeInstance) assertInstanceExportAllowed(user);
  const serverIds = selectedExportServerIdsOrAll(selectedExportServerIds(request.body?.serverIds));
  return startExportOperation({
    serverIds,
    includeInstance
  }, user.id);
});

// The artifact is JSON, so global compression would otherwise encode it and drop the
// Content-Length this route sets -- leaving the browser's download UI without a size for a
// file that can run to hundreds of megabytes.
app.get<{ Params: { operationId: string } }>("/api/exports/:operationId/download", { compress: false }, async (request, reply) => {
  const user = await requireRequestPermission(request, "servers.export");
  const operation = services.operationsRepository.find(validateOperationId(request.params.operationId));
  if (!operation || operation.type !== "export.run" || operation.createdBy !== user.id) {
    return reply.code(404).send(apiErrorResponse("EXPORT_NOT_FOUND", "Export operation not found"));
  }
  if (operation.status !== "succeeded") {
    throw new Error("Export is not ready for download");
  }
  const expiresAt = exportArtifactExpiresAt(operation, config.exportRetentionMs);
  if (expiresAt !== undefined && expiresAt <= Date.now()) {
    await services.exportArtifactMaintenance.expireOperation(operation).catch((error) => {
      logWarn({ operationId: operation.id, errorDetails: detailedErrorMessage(error) }, "Could not remove an expired export artifact during download");
    });
    return reply.code(410).send(apiErrorResponse("EXPORT_EXPIRED", "Export artifact has expired"));
  }
  const result = exportOperationResult(operation);
  if (!Array.isArray(result.serverIds) || typeof result.includeInstance !== "boolean") {
    return reply.code(410).send(apiErrorResponse("EXPORT_REGENERATION_REQUIRED", "This export predates current authorization metadata and must be regenerated"));
  }
  if (result.includeInstance) assertInstanceExportAllowed(user);
  const artifactPath = result?.artifactPath;
  if (!artifactPath || !isInsideServersDirectory(config.exportsDir, artifactPath)) {
    throw new Error("Export artifact is not available");
  }
  try {
    await stat(artifactPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return reply.code(404).send(apiErrorResponse("EXPORT_NOT_FOUND", "Export artifact is not available"));
    }
    throw error;
  }
  reply.header("content-type", "application/json");
  reply.header("content-disposition", `attachment; filename="${result.artifact?.filename ?? exportArtifactFilename(operation.id)}"`);
  if (result.artifact?.size) reply.header("content-length", String(result.artifact.size));
  return reply.send(exportDownloadStream(artifactPath));
});

app.post<{ Body: { artifactBase64?: string; targetNodeId?: string; importInstanceSettings?: boolean } }>("/api/imports/validate", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.create");
  const importInstanceSettings = optionalStrictBoolean(request.body.importInstanceSettings, "importInstanceSettings", false);
  if (importInstanceSettings) await requireRequestPermission(request, "integrations.manage");
  const artifact = parseExportArtifactBase64(request.body.artifactBase64 ?? "");
  return validateImportArtifact(artifact, {
    targetNodeId: typeof request.body.targetNodeId === "string" ? request.body.targetNodeId.trim() : undefined,
    importInstanceSettings,
    nodes: await readNodes(),
    existingServers: await listManagedServers(),
    serversDir: config.serversDir,
    tmpDir: config.tmpDir
  });
});

app.post<{ Body: { artifactBase64?: string; targetNodeId?: string; importInstanceSettings?: boolean } }>("/api/imports/apply", destructiveRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.create");
  const importInstanceSettings = optionalStrictBoolean(request.body.importInstanceSettings, "importInstanceSettings", false);
  if (importInstanceSettings) await requireRequestPermission(request, "integrations.manage");
  return startImportOperation({
    artifactBase64: request.body.artifactBase64 ?? "",
    targetNodeId: targetNodeIdFromBody(request.body.targetNodeId),
    importInstanceSettings
  }, user.id);
});

}
