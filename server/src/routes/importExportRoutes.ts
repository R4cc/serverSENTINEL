import type { FastifyInstance } from "fastify";
import type { MultipartFile } from "@fastify/multipart";

import { createWriteStream } from "node:fs";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { EXPORT_CATEGORY_DESCRIPTORS } from "@serversentinel/contracts";
import { config } from "../config.js";
import { destructiveRateLimit, importChunkRateLimit } from "../http/rateLimits.js";
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

const importUploadChunkMaxBytes = 16 * 1024 * 1024;
const activeImportUploads = new Set<string>();

/** Uploaded archives live here until an import operation consumes them. */
function importStagingPath(importId: string) {
  return join(config.importsDir, `import-${importId}.zip`);
}

function importPendingPath(importId: string) {
  return join(config.importsDir, `import-${importId}.upload`);
}

function validateImportId(value: unknown) {
  const importId = typeof value === "string" ? value.trim() : "";
  if (!/^[0-9a-f-]{36}$/i.test(importId)) throw new Error("A valid uploaded archive id is required");
  return importId;
}

function optionalExportInventoryId(value: unknown) {
  const inventoryId = typeof value === "string" ? value.trim() : "";
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(inventoryId)
    ? inventoryId
    : undefined;
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

async function resolvePendingUpload(importId: string) {
  const path = resolve(importPendingPath(importId));
  if (!isInsideServersDirectory(config.importsDir, path)) {
    throw new Error("Pending import upload is not available");
  }
  try {
    await stat(path);
  } catch {
    throw new Error("Pending import upload is no longer available. Start the upload again.");
  }
  return path;
}

function multipartField(part: MultipartFile, name: string) {
  const raw = part.fields[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value && value.type === "field" && typeof value.value === "string" ? value.value : undefined;
}

function positiveUploadSize(value: unknown) {
  const size = typeof value === "number" ? value : Number.NaN;
  if (!Number.isSafeInteger(size) || size < 1 || size > config.importMaxExpandedBytes) {
    throw new Error(`Export archive size must be between 1 byte and ${Math.floor(config.importMaxExpandedBytes / 1024 / 1024 / 1024)} GiB`);
  }
  return size;
}

export function registerImportExportRoutes(app: FastifyInstance) {

app.get("/api/exports/categories", async (request) => {
  await requireRequestPermission(request, "servers.export");
  return { categories: EXPORT_CATEGORY_DESCRIPTORS };
});

app.post<{ Body: { serverIds?: unknown; selection?: unknown } }>("/api/exports/estimate", async (request) => {
  const user = await requireRequestPermission(request, "servers.export");
  const selection = normalizeExportSelection(request.body?.selection);
  const serverIds = selectedExportServerIdsOrAll(selectedExportServerIds(request.body?.serverIds));
  return estimateExport(serverIds, selection, user.id);
});

app.post<{ Body: { serverIds?: unknown; selection?: unknown; inventoryId?: unknown } }>("/api/exports", destructiveRateLimit, async (request, reply) => {
  const user = await requireRequestPermission(request, "servers.export");
  const selection = normalizeExportSelection(request.body?.selection);
  const serverIds = selectedExportServerIdsOrAll(selectedExportServerIds(request.body?.serverIds));
  // Server-state, size, disk-space, and any fallback filesystem walk run inside the queued operation
  // so this request always returns an operation id before a reverse proxy can time out.
  const operation = await startExportOperation({
    serverIds,
    selection,
    inventoryId: optionalExportInventoryId(request.body?.inventoryId)
  }, user.id);
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

app.delete<{ Params: { operationId: string } }>("/api/exports/:operationId", destructiveRateLimit, async (request, reply) => {
  const user = await requireRequestPermission(request, "servers.export");
  const operation = services.operationsRepository.find(validateOperationId(request.params.operationId));
  if (!operation || operation.type !== "export.run" || operation.status !== "succeeded" || operation.createdBy !== user.id) {
    return reply.code(404).send(apiErrorResponse("EXPORT_NOT_FOUND", "Export operation not found"));
  }
  if (!await services.exportArtifactMaintenance.deleteSuccessfulExport(operation)) {
    throw new Error("Export artifact could not be deleted");
  }
  return { ok: true };
});

/**
 * Import is a two-step: the archive is uploaded once and validated and applied by reference. A world
 * makes the artifact far too large to resend for validation and again for apply, and far too large
 * to carry as base64 in a JSON body the way schema 3 did.
 */
app.post<{ Body: { size?: unknown } }>("/api/imports/uploads", destructiveRateLimit, async (request, reply) => {
  await requireRequestPermission(request, "servers.create");
  positiveUploadSize(request.body?.size);
  const importId = randomUUID();
  await mkdir(config.importsDir, { recursive: true, mode: 0o700 });
  await writeFile(importPendingPath(importId), Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  return reply.code(201).send({ importId, chunkSize: importUploadChunkMaxBytes });
});

app.post<{ Params: { importId: string } }>("/api/imports/:importId/chunks", importChunkRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.create");
  const importId = validateImportId(request.params.importId);
  if (activeImportUploads.has(importId)) {
    throw new Error("Another chunk is already being saved for this import");
  }
  activeImportUploads.add(importId);
  let path: string | undefined;
  let startingSize: number | undefined;
  try {
    path = await resolvePendingUpload(importId);
    const part = await request.file({ limits: { fileSize: importUploadChunkMaxBytes, files: 1 } });
    if (!part) throw new Error("An export archive chunk is required");
    const offset = Number(multipartField(part, "offset"));
    const current = await stat(path);
    startingSize = current.size;
    if (!Number.isSafeInteger(offset) || offset < 0 || offset !== startingSize) {
      part.file.destroy();
      throw new Error(`Import upload offset ${offset} does not match the saved size ${startingSize}`);
    }
    if (startingSize >= config.importMaxExpandedBytes) {
      part.file.destroy();
      throw new Error("Export archive has reached the configured import limit");
    }
    await pipeline(part.file, createWriteStream(path, { flags: "a", mode: 0o600 }));
    const written = await stat(path);
    if (part.file.truncated || written.size > config.importMaxExpandedBytes) {
      await truncate(path, startingSize);
      throw new Error(`Export archive chunk exceeds the ${Math.floor(importUploadChunkMaxBytes / 1024 / 1024)} MiB chunk limit`);
    }
    if (written.size === startingSize) {
      throw new Error("Export archive chunk is empty");
    }
    return { received: written.size };
  } catch (error) {
    if (path && startingSize !== undefined) await truncate(path, startingSize).catch(() => undefined);
    throw error;
  } finally {
    activeImportUploads.delete(importId);
  }
});

app.post<{ Body: { size?: unknown }; Params: { importId: string } }>("/api/imports/:importId/complete", destructiveRateLimit, async (request) => {
  await requireRequestPermission(request, "servers.create");
  const importId = validateImportId(request.params.importId);
  if (activeImportUploads.has(importId)) {
    throw new Error("The final import chunk is still being saved");
  }
  activeImportUploads.add(importId);
  try {
    const path = await resolvePendingUpload(importId);
    const expectedSize = positiveUploadSize(request.body?.size);
    const written = await stat(path);
    if (written.size !== expectedSize) {
      throw new Error(`Import upload is incomplete: received ${written.size} of ${expectedSize} bytes`);
    }
    await rename(path, importStagingPath(importId));
    return { importId, size: written.size };
  } finally {
    activeImportUploads.delete(importId);
  }
});

// Kept for older browser builds. Current clients use bounded chunks so reverse proxies never need
// to accept a multi-gigabyte request body in one HTTP request.
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
  const importId = validateImportId(request.params.importId);
  if (activeImportUploads.has(importId)) {
    throw new Error("Import upload is still being saved");
  }
  await Promise.all([
    rm(importStagingPath(importId), { force: true }),
    rm(importPendingPath(importId), { force: true })
  ]);
  return { ok: true };
});

}
