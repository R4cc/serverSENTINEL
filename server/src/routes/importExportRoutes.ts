import type { FastifyInstance } from "fastify";

import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { EXPORT_CATEGORY_DESCRIPTORS } from "@serversentinel/contracts";
import { config } from "../config.js";
import { destructiveRateLimit } from "../http/rateLimits.js";
import { requireRequestPermission } from "../auth/sessionService.js";
import {
  estimateExport,
  selectedExportServerIds,
  startExportOperation,
  startImportOperation,
  targetNodeIdFromBody,
  validateImportArchiveFile
} from "../operations/importExportService.js";
import { selectedExportServerIdsOrAll } from "../exportAuthorization.js";
import { exportOperationResult, exportOperationServerIds } from "../exportArtifactMaintenance.js";
import { exportArtifactFilename, exportDownloadStream } from "../importExport.js";
import { normalizeExportSelection } from "../servers/exportSelection.js";
import { validateOperationId } from "../http/validation.js";
import { apiErrorResponse } from "../http/errors.js";
import { isInsideServersDirectory } from "../storage/serverIdentity.js";
import { services } from "../appServices.js";
import { isFullAccessUser } from "../permissions.js";
import { getServer } from "../servers/store.js";

/** Uploaded archives live here until an import operation consumes them. */
function importStagingPath(importId: string) {
  return join(config.importsDir, `import-${importId}.zip`);
}

function validateImportId(value: unknown) {
  const importId = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(importId)) throw new Error("A valid uploaded archive id is required");
  return importId;
}

async function resolveUploadedArchive(importId: string) {
  const path = resolve(importStagingPath(importId));
  if (!isInsideServersDirectory(config.importsDir, path)) {
    throw new Error("Uploaded archive is not available");
  }
  try {
    await stat(path);
  } catch {
    throw new Error("Uploaded archive is no longer available. Upload it again.");
  }
  return path;
}

export function registerImportExportRoutes(app: FastifyInstance) {

app.get("/api/exports/categories", async (request) => {
  await requireRequestPermission(request, "servers.export");
  return { categories: EXPORT_CATEGORY_DESCRIPTORS };
});

app.post<{ Body: { serverIds?: unknown; selection?: unknown } }>("/api/exports/estimate", async (request) => {
  await requireRequestPermission(request, "servers.export");
  const selection = normalizeExportSelection(request.body?.selection);
  const serverIds = selectedExportServerIdsOrAll(selectedExportServerIds(request.body?.serverIds));
  return estimateExport(serverIds, selection);
});

app.post<{ Body: { serverIds?: unknown; selection?: unknown } }>("/api/exports", destructiveRateLimit, async (request, reply) => {
  const user = await requireRequestPermission(request, "servers.export");
  const selection = normalizeExportSelection(request.body?.selection);
  const serverIds = selectedExportServerIdsOrAll(selectedExportServerIds(request.body?.serverIds));
  // Server-state, file-selection, size-limit, and disk-space checks run inside the queued operation.
  // Walking a multi-gigabyte world here duplicates the modal's estimate and can hold this request
  // open past a reverse proxy timeout before the browser receives an operation id to poll.
  const operation = await startExportOperation({ serverIds, selection }, user.id);
  return reply.code(202).send(operation);
});

app.get<{ Params: { id: string } }>("/api/servers/:id/exports", async (request) => {
  const user = await requireRequestPermission(request, "servers.export");
  const server = await getServer(request.params.id);
  const exports = services.operationsRepository.listExportOperations()
    .filter((operation) => exportOperationServerIds(operation).includes(server.id));
  const latest = exports[0];
  const retained = exports.find((operation) => (
    operation.status === "succeeded"
    && typeof exportOperationResult(operation).artifactPath === "string"
  ));
  const active = latest && (latest.status === "queued" || latest.status === "running");
  const retainedArtifact = retained ? exportOperationResult(retained).artifact : undefined;
  return {
    latest: latest ? {
      id: latest.id,
      status: latest.status,
      progress: latest.progress,
      task: latest.task,
      createdAt: latest.createdAt,
      startedAt: latest.startedAt,
      finishedAt: latest.finishedAt,
      errorMessage: latest.errorMessage,
      startedByRequester: latest.createdBy === user.id,
      canCancel: Boolean(
        active
        && services.exportCoordinator.isCancellationAvailable(latest.id)
        && (latest.createdBy === user.id || isFullAccessUser(user))
      )
    } : null,
    artifact: retained && retainedArtifact ? {
      operationId: retained.id,
      filename: retainedArtifact.filename,
      size: retainedArtifact.size,
      createdAt: retained.finishedAt ?? retained.createdAt,
      downloadUrl: retained.createdBy === user.id ? retainedArtifact.downloadUrl : undefined
    } : null
  };
});

// The artifact is a ZIP, so global compression would only re-encode it and drop the Content-Length
// this route sets -- leaving the browser's download UI without a size for a multi-gigabyte file.
app.get<{ Params: { operationId: string } }>("/api/exports/:operationId/download", { compress: false }, async (request, reply) => {
  const user = await requireRequestPermission(request, "servers.export");
  const operation = services.operationsRepository.find(validateOperationId(request.params.operationId));
  if (!operation || operation.type !== "export.run" || operation.createdBy !== user.id) {
    return reply.code(404).send(apiErrorResponse("EXPORT_NOT_FOUND", "Export operation not found"));
  }
  if (operation.status !== "succeeded") {
    throw new Error("Export is not ready for download");
  }
  const result = exportOperationResult(operation);
  if (!Array.isArray(result.serverIds) || !result.selection) {
    return reply.code(410).send(apiErrorResponse("EXPORT_REGENERATION_REQUIRED", "This export predates the current artifact format and must be regenerated"));
  }
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
  reply.header("content-type", "application/zip");
  reply.header("content-disposition", `attachment; filename="${result.artifact?.filename ?? exportArtifactFilename(operation.id)}"`);
  if (result.artifact?.size) reply.header("content-length", String(result.artifact.size));
  return reply.send(exportDownloadStream(artifactPath));
});

/**
 * Import is a two-step: the archive is uploaded once and validated and applied by reference. A world
 * makes the artifact far too large to resend for validation and again for apply, and far too large
 * to carry as base64 in a JSON body the way schema 3 did.
 */
app.post("/api/imports/upload", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.create");
  const part = await request.file({ limits: { fileSize: config.importMaxExpandedBytes, files: 1 } });
  if (!part) throw new Error("An export archive file is required");
  const importId = randomUUID();
  const path = importStagingPath(importId);
  await mkdir(config.importsDir, { recursive: true, mode: 0o700 });
  try {
    await pipeline(part.file, createWriteStream(path, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    await rm(path, { force: true }).catch(() => undefined);
    throw error;
  }
  if (part.file.truncated) {
    await rm(path, { force: true }).catch(() => undefined);
    throw new Error(`Export archive exceeds the ${Math.floor(config.importMaxExpandedBytes / 1024 / 1024 / 1024)} GiB upload limit`);
  }
  const written = await stat(path);
  return { importId, size: written.size };
});

app.post<{ Body: { importId?: unknown; targetNodeId?: unknown } }>("/api/imports/validate", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.create");
  const archivePath = await resolveUploadedArchive(validateImportId(request.body?.importId));
  const targetNodeId = typeof request.body?.targetNodeId === "string" ? request.body.targetNodeId.trim() : "";
  return validateImportArchiveFile(archivePath, targetNodeId);
});

app.post<{ Body: { importId?: unknown; targetNodeId?: unknown } }>("/api/imports/apply", destructiveRateLimit, async (request) => {
  const user = await requireRequestPermission(request, "servers.create");
  const archivePath = await resolveUploadedArchive(validateImportId(request.body?.importId));
  return startImportOperation({
    archivePath,
    targetNodeId: targetNodeIdFromBody(request.body?.targetNodeId)
  }, user.id);
});

app.delete<{ Params: { importId: string } }>("/api/imports/:importId", async (request) => {
  await requireRequestPermission(request, "servers.create");
  const archivePath = await resolveUploadedArchive(validateImportId(request.params.importId));
  await rm(archivePath, { force: true });
  return { ok: true };
});

}
