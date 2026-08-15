import type { FastifyInstance } from "fastify";
import { basename, dirname, join, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { runtimeForServer, services } from "../appServices.js";

import { destructiveRateLimit } from "../http/rateLimits.js";
import { throwHttp } from "../http/errors.js";

import { multipartUpload } from "../http/multipart.js";
import { requireRequestPermission } from "../auth/sessionService.js";
import { getServer } from "../servers/store.js";
import { operationErrorMessage, requireServerStoppedForMutableConfiguration } from "../servers/lifecycle.js";
import { archiveDownloadTokens, assertFileRevision, cleanupArchiveDownloadTokens, createArchiveDownloadToken, dedupeDownloadSelections, downloadSelection, fileContentRevision, fileDownloadIntentMode, fileEditLockPath, fileLeaseOwner, fileRevisionConflict, publicFileEditLease, readFileWithRevision, requireFilePathPermission, assertDownloadSize, prepareDownload, type DownloadSelection } from "../files/fileService.js";
import { withTrackedModMutation } from "../mods/modService.js";
import { fileUploadSizeLimit, safeFileManagerName } from "../runtime/local/fileService.js";
import { localNodeId } from "../nodes/nodeService.js";
import { type ZipExtractionPlan } from "../zipArchive.js";

import { detailedErrorMessage } from "../logging.js";
import type { NodeRuntime } from "../nodes/types.js";
import type { ManagedServer, Permission } from "../types.js";

export function registerFileRoutes(app: FastifyInstance) {
const withFileMutation = <T>(server: ManagedServer, action: () => Promise<T>) => services.exportCoordinator.withMutation(server.id, action);
app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/files", async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.query.path ?? ".");
  await requireFilePathPermission(request, server, target, "files.view");
  return runtime.listFiles(server, target);
});

async function resolveZipArchive(runtime: NodeRuntime, server: ManagedServer, path?: string) {
  const target = await runtime.resolveExistingPath(server, path ?? "");
  if (!/\.zip$/i.test(basename(target))) throw new Error("Only .zip archives can be opened");
  if (server.nodeId === localNodeId && !(await stat(target)).isFile()) throw new Error("Archive path is not a file");
  return target;
}

async function resolveArchiveDestination(runtime: NodeRuntime, server: ManagedServer, path?: string) {
  const destinationPath = path ?? "";
  try {
    return await runtime.resolveExistingPath(server, destinationPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return runtime.resolveWritablePath(server, destinationPath);
  }
}

function requireNoRunningFileExtraction(serverId: string) {
  const running = services.operationsRepository.listActive(serverId).some((operation) => operation.type === "file.extract");
  if (running) throw new Error("File mutations are unavailable while ZIP extraction is running");
}

function archiveOutputPermission(path: string): Permission {
  if (path === "/server.properties") return "servers.editSettings";
  if (path === "/mods" || path.startsWith("/mods/") || path === "/plugins" || path.startsWith("/plugins/")) return "mods.upload";
  return "files.upload";
}

async function requireArchiveExtractionPermissions(
  request: { headers: { cookie?: string } },
  server: ManagedServer,
  runtime: NodeRuntime,
  destination: string,
  plan: ZipExtractionPlan
) {
  const destinationPublicPath = runtime.publicPath(server, destination);
  const paths = new Set([destinationPublicPath, ...plan.outputPaths.map((entry) => entry.path)]);
  let touchesMods = false;
  let touchesServerSettings = false;
  for (const path of paths) {
    const permission = archiveOutputPermission(path);
    await requireRequestPermission(request, permission);
    touchesMods ||= permission === "mods.upload";
    touchesServerSettings ||= permission === "servers.editSettings";
  }
  if (touchesServerSettings) await requireServerStoppedForMutableConfiguration(server);
  return touchesMods;
}

app.post<{ Params: { id: string }; Body: { path?: string; destinationPath?: string; conflictPolicy?: string } }>("/api/servers/:id/files/archive/extract", destructiveRateLimit, async (request, reply) => {
  const server = await getServer(request.params.id);
  services.exportCoordinator.assertMutationAllowed(server.id);
  const runtime = runtimeForServer(server);
  const archive = await resolveZipArchive(runtime, server, request.body.path);
  await requireFilePathPermission(request, server, archive, "files.view");
  const destination = await resolveArchiveDestination(runtime, server, request.body.destinationPath);
  const conflictPolicy = request.body.conflictPolicy;
  if (conflictPolicy !== "replace" && conflictPolicy !== "skip") throw new Error("conflictPolicy must be replace or skip");
  const alreadyRunning = services.operationsRepository.listActive(server.id).some((operation) => operation.type === "file.extract");
  if (alreadyRunning) throw new Error("Another ZIP extraction is already running for this server");
  const user = await requireRequestPermission(request);
  // The claim is taken before the archive is read. Planning reads it, the permission decision below
  // is made from that plan, and extraction opens it a third time — so with the claim taken after
  // planning the archive could be deleted and re-uploaded in between, and files authorized from one
  // archive were written from another. Every mutating file route honours this claim.
  const operation = services.operationsRepository.create({
    type: "file.extract",
    serverId: server.id,
    nodeId: server.nodeId,
    createdBy: user.id,
    progress: 0,
    task: `Extracting ${basename(archive)}`
  });
  services.operationsRepository.update(operation.id, {
    result: { archivePath: runtime.publicPath(server, archive), destinationPath: runtime.publicPath(server, destination) }
  });
  services.operationsRepository.start(operation.id, { progress: 5, task: `Validating ${basename(archive)}` });
  let touchesMods: boolean;
  try {
    const plan = await runtime.planArchiveExtraction(server, archive, destination);
    if (plan.blocked.length) throw new Error(`Extraction is blocked by ${plan.blocked[0].path}`);
    touchesMods = await requireArchiveExtractionPermissions(request, server, runtime, destination, plan);
  } catch (error) {
    // The claim must not outlive a refusal, or the server is left unable to accept file mutations.
    services.operationsRepository.fail(operation.id, operationErrorMessage(error, "ZIP extraction failed"), { task: "Extraction failed" });
    throw error;
  }
  const extract = () => runtime.extractArchive(server, archive, destination, conflictPolicy, (progress, task) => {
    services.operationsRepository.update(operation.id, { progress: 10 + Math.round(progress * 0.85), task });
  });
  void (touchesMods ? withTrackedModMutation(server, extract) : withFileMutation(server, extract)).then(async (result) => {
    services.operationsRepository.succeed(operation.id, { progress: 100, task: "Extraction complete", result: { ...result, archivePath: runtime.publicPath(server, archive) } });
  }).catch((error) => {
    services.operationsRepository.fail(operation.id, operationErrorMessage(error, "ZIP extraction failed"), { task: "Extraction failed", logSummary: detailedErrorMessage(error) });
  });
  return reply.code(202).send(services.operationsRepository.find(operation.id)!);
});

app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/file/preview", async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.query.path ?? "");
  await requireFilePathPermission(request, server, target, "files.view");
  return runtime.previewFile(server, target);
});

app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/file/download", async (request, reply) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.query.path ?? "");
  await requireFilePathPermission(request, server, target, "files.download");
  const selection = await downloadSelection(runtime, server, target);
  if (selection.type !== "file") throw new Error("Only files can be downloaded");
  assertDownloadSize(selection.size);
  const download = await runtime.downloadFile(server, target);
  return reply
    .header("Content-Type", "application/octet-stream")
    .header("Content-Length", download.size)
    .header("Content-Disposition", `attachment; filename="${encodeURIComponent(download.filename)}"`)
    .send(download.stream);
});

app.post<{ Params: { id: string }; Body: { paths?: unknown } }>("/api/servers/:id/files/download/intent", async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const rawPaths = Array.isArray(request.body.paths) ? request.body.paths : [];
  if (rawPaths.length < 1) throw new Error("At least one file or folder path is required");
  if (rawPaths.length > 200) throw new Error("A download selection is limited to 200 items");

  const selections: DownloadSelection[] = [];
  for (const rawPath of rawPaths) {
    if (typeof rawPath !== "string") throw new Error("Download paths must be strings");
    const target = await runtime.resolveExistingPath(server, rawPath);
    await requireFilePathPermission(request, server, target, "files.download");
    selections.push(await downloadSelection(runtime, server, target));
  }
  const deduped = dedupeDownloadSelections(selections);
  const fileOnly = deduped.every((entry) => entry.type === "file");
  const selectedFileCount = deduped.filter((entry) => entry.type === "file").length;
  const selectedFileSize = deduped.reduce((total, entry) => total + (entry.type === "file" ? entry.size : 0), 0);
  assertDownloadSize(selectedFileSize);

  const mode = fileDownloadIntentMode({ hasDirectory: !fileOnly, fileCount: selectedFileCount, totalSize: selectedFileSize });
  if (mode === "individual") {
    return {
      mode: "individual",
      totalSize: selectedFileSize,
      files: deduped.map((entry) => ({
        name: entry.name,
        path: entry.path,
        size: entry.size,
        url: `/api/servers/${encodeURIComponent(server.id)}/file/download?path=${encodeURIComponent(entry.path)}`
      }))
    };
  }

  const prepared = await prepareDownload(request, runtime, server, deduped);
  const token = createArchiveDownloadToken(server.id, prepared);
  return {
    mode: "archive",
    totalSize: prepared.totalSize,
    filename: prepared.archiveFilename,
    url: `/api/servers/${encodeURIComponent(server.id)}/files/download/archive/${encodeURIComponent(token)}`,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
  };
});

app.get<{ Params: { id: string; token: string } }>("/api/servers/:id/files/download/archive/:token", async (request, reply) => {
  cleanupArchiveDownloadTokens();
  const token = archiveDownloadTokens.get(request.params.token);
  if (!token || token.serverId !== request.params.id) throw new Error("Download archive is no longer available");
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  for (const entry of token.entries) {
    const target = await runtime.resolveExistingPath(server, entry.sourcePath);
    await requireFilePathPermission(request, server, target, "files.download");
  }
  const download = await runtime.downloadArchive(server, token.entries, token.filename);
  return reply
    .header("Content-Type", "application/zip")
    .header("Content-Disposition", `attachment; filename="${encodeURIComponent(download.filename)}"`)
    .send(download.stream);
});

app.get<{ Params: { id: string }; Querystring: { path?: string } }>("/api/servers/:id/file", async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.query.path ?? "");
  await requireFilePathPermission(request, server, target, "files.view");
  return readFileWithRevision(runtime, server, target);
});

app.post<{ Params: { id: string }; Body: { path?: string; revision?: string } }>("/api/servers/:id/file/lease", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.body.path ?? "");
  const user = await requireFilePathPermission(request, server, target, runtime.isServerSettingsFile(server, target) ? "servers.editSettings" : "files.edit");
  if (runtime.isServerSettingsFile(server, target)) await requireServerStoppedForMutableConfiguration(server);
  const file = await readFileWithRevision(runtime, server, target);
  if (!request.body.revision || request.body.revision !== file.revision) fileRevisionConflict();
  const path = await fileEditLockPath(runtime, server, target);
  const lease = services.fileEditLeasesRepository.acquire({
    serverId: server.id,
    path,
    fileRevision: file.revision,
    owner: fileLeaseOwner(request, user)
  });
  return { lease: publicFileEditLease(lease) };
});

app.post<{ Params: { id: string; leaseId: string } }>("/api/servers/:id/file/lease/:leaseId/heartbeat", async (request) => {
  const user = await requireRequestPermission(request);
  const lease = services.fileEditLeasesRepository.heartbeat(request.params.leaseId, fileLeaseOwner(request, user));
  if (lease.serverId !== request.params.id) {
    throwHttp(409, "The edit lease does not belong to this server", { code: "file_edit_lease_lost" });
  }
  return { lease: publicFileEditLease(lease) };
});

app.delete<{ Params: { id: string; leaseId: string }; Querystring: { force?: string } }>("/api/servers/:id/file/lease/:leaseId", async (request) => {
  if (request.query.force === "true") {
    await requireRequestPermission(request, "users.manage");
    return { ok: services.fileEditLeasesRepository.forceRelease(request.params.leaseId, request.params.id) };
  }
  const user = await requireRequestPermission(request);
  return { ok: services.fileEditLeasesRepository.release(request.params.leaseId, fileLeaseOwner(request, user)) };
});

app.put<{ Params: { id: string }; Body: { path?: string; content?: string; leaseId?: string; revision?: string } }>("/api/servers/:id/file", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  requireNoRunningFileExtraction(server.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.body.path ?? "");
  const user = await requireFilePathPermission(request, server, target, runtime.isServerSettingsFile(server, target) ? "servers.editSettings" : "files.edit");
  if (runtime.isServerSettingsFile(server, target)) await requireServerStoppedForMutableConfiguration(server);
  if (!request.body.leaseId) {
    throwHttp(409, "A valid file edit lease is required", { code: "file_edit_lease_lost" });
  }
  const path = await fileEditLockPath(runtime, server, target);
  const owner = fileLeaseOwner(request, user);
  const lease = services.fileEditLeasesRepository.requireOwned(request.body.leaseId, server.id, path, owner);
  const current = await readFileWithRevision(runtime, server, target);
  assertFileRevision(request.body.revision, lease.fileRevision, current.revision);
  const result = await withFileMutation(server, () => runtime.writeFile(server, target, request.body.content)) as Record<string, unknown>;
  services.fileEditLeasesRepository.release(lease.leaseId, owner);
  return { ...result, revision: fileContentRevision(request.body.content ?? "") };
});

app.post<{ Params: { id: string }; Body: { path?: string; name?: string } }>("/api/servers/:id/folder", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  requireNoRunningFileExtraction(server.id);
  const runtime = runtimeForServer(server);
  const parent = await runtime.resolveExistingPath(server, request.body.path ?? ".");
  await requireFilePathPermission(request, server, parent, "files.upload");
  return withFileMutation(server, () => runtime.createFolder(server, parent, request.body.name));
});

app.post<{ Params: { id: string } }>("/api/servers/:id/files/upload", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  services.exportCoordinator.assertMutationAllowed(server.id);
  requireNoRunningFileExtraction(server.id);
  const runtime = runtimeForServer(server);
  if (!request.isMultipart()) throw new Error("File uploads require multipart form data");
  const uploadRequest = await multipartUpload(request, fileUploadSizeLimit);
  const parent = await runtime.resolveExistingPath(server, uploadRequest.path ?? ".");
  if (server.nodeId === localNodeId) {
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) {
      throw new Error("Upload path is not a directory");
    }
  }
  const filename = safeFileManagerName(uploadRequest.filename);
  const target = join(parent, filename);
  const uploadPermission: Permission = runtime.isServerSettingsFile(server, target)
    ? "servers.editSettings"
    : runtime.isModsPath(server, target) && (filename.endsWith(".jar") || filename.endsWith(".jar.disabled"))
      ? "mods.upload"
      : "files.upload";
  await requireFilePathPermission(request, server, parent, uploadPermission);
  if (runtime.isServerSettingsFile(server, target)) await requireServerStoppedForMutableConfiguration(server);
  const touchesMods = runtime.isModsPath(server, target);
  const upload = () => runtime.uploadFile(server, parent, filename, uploadRequest.content);
  return touchesMods ? withTrackedModMutation(server, upload) : withFileMutation(server, upload);
});

app.patch<{ Params: { id: string }; Body: { path?: string; name?: string } }>("/api/servers/:id/file", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  requireNoRunningFileExtraction(server.id);
  const runtime = runtimeForServer(server);
  const source = await runtime.resolveExistingPath(server, request.body.path ?? "");
  if (resolve(source) === resolve(server.serverDir)) {
    throw new Error("Refusing to rename the server root directory");
  }
  const targetName = safeFileManagerName(request.body.name);
  const target = await runtime.resolveWritableResolvedPath(server, join(dirname(source), targetName));
  await requireFilePathPermission(request, server, source, runtime.fileRenamePermission(server, source, target));
  const touchesSettings = runtime.isServerSettingsFile(server, source) || runtime.isServerSettingsFile(server, target);
  const touchesMods = runtime.isModsPath(server, source) || runtime.isModsPath(server, target);
  if (touchesSettings) await requireServerStoppedForMutableConfiguration(server);
  const renameEntry = () => runtime.renameFile(server, source, targetName);
  return touchesMods ? withTrackedModMutation(server, renameEntry) : withFileMutation(server, renameEntry);
});

app.post<{ Params: { id: string }; Body: { path?: string; destinationPath?: string } }>("/api/servers/:id/file/move", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  requireNoRunningFileExtraction(server.id);
  const runtime = runtimeForServer(server);
  const source = await runtime.resolveExistingPath(server, request.body.path ?? "");
  if (resolve(source) === resolve(server.serverDir)) throw new Error("Refusing to move the server root directory");
  const destination = await runtime.resolveExistingPath(server, request.body.destinationPath ?? ".");
  const targetInput = destination === "." ? basename(source) : `${destination.replace(/[\\/]+$/, "")}/${basename(source)}`;
  const target = await runtime.resolveWritableResolvedPath(server, targetInput);
  await requireFilePathPermission(request, server, source, runtime.fileRenamePermission(server, source, source));
  await requireFilePathPermission(request, server, target, runtime.fileRenamePermission(server, target, target));
  const touchesSettings = runtime.isServerSettingsFile(server, source) || runtime.isServerSettingsFile(server, target);
  const touchesMods = runtime.isModsPath(server, source) || runtime.isModsPath(server, target);
  if (touchesSettings) await requireServerStoppedForMutableConfiguration(server);
  const moveEntry = () => runtime.moveFile(server, source, destination);
  return touchesMods ? withTrackedModMutation(server, moveEntry) : withFileMutation(server, moveEntry);
});

app.post<{ Params: { id: string }; Body: { path?: string; name?: string } }>("/api/servers/:id/file/duplicate", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  requireNoRunningFileExtraction(server.id);
  const runtime = runtimeForServer(server);
  const source = await runtime.resolveExistingPath(server, request.body.path ?? "");
  await requireFilePathPermission(request, server, source, runtime.isModsPath(server, source) ? "mods.upload" : "files.upload");
  const touchesMods = runtime.isModsPath(server, source);
  if (runtime.isServerSettingsFile(server, source)) await requireServerStoppedForMutableConfiguration(server);
  const duplicate = () => runtime.duplicateFile(server, source, request.body.name);
  return touchesMods ? withTrackedModMutation(server, duplicate) : withFileMutation(server, duplicate);
});

app.delete<{ Params: { id: string }; Querystring: { path?: string; recursive?: string } }>("/api/servers/:id/file", destructiveRateLimit, async (request) => {
  const server = await getServer(request.params.id);
  requireNoRunningFileExtraction(server.id);
  const runtime = runtimeForServer(server);
  const target = await runtime.resolveExistingPath(server, request.query.path ?? "");
  await requireFilePathPermission(request, server, target, runtime.isModsPath(server, target) ? "mods.remove" : "files.delete");
  const touchesMods = runtime.isModsPath(server, target);
  if (runtime.isServerSettingsFile(server, target)) await requireServerStoppedForMutableConfiguration(server);
  const deleteEntry = () => runtime.deleteFile(server, target, request.query.recursive);
  return touchesMods ? withTrackedModMutation(server, deleteEntry) : withFileMutation(server, deleteEntry);
});

}
