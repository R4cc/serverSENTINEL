import { createHash, randomUUID } from "node:crypto";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { config } from "../config.js";
import { throwHttp, unauthorized } from "../http/errors.js";
import { parseCookies, requireRequestPermission, sessionCookieName } from "../auth/sessionService.js";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { ensureWritableInsideServer, normalizePublicFilePath, validateExistingInsideServer } from "../core.js";
import { runtimeTarget } from "../runtime/profile.js";
import { toPublicServerPath } from "../runtime/local/fileService.js";
import { localNodeId } from "../nodes/nodeService.js";
import { safeArchiveFilename, type FileArchiveEntry } from "../downloadArchive.js";
import type { NodeRuntime } from "../nodes/types.js";
import type { FileEditLease, ManagedServer, Permission, StoredUser } from "../types.js";

type DownloadIntentEntry = {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number;
  modifiedAt?: string;
};

export type DownloadSelection = DownloadIntentEntry & {
  target: string;
};

type PreparedDownload = {
  entries: FileArchiveEntry[];
  totalSize: number;
  archiveFilename: string;
};

type ArchiveDownloadToken = {
  serverId: string;
  entries: FileArchiveEntry[];
  filename: string;
  totalSize: number;
  expiresAt: number;
};

export const archiveDownloadTokens = new Map<string, ArchiveDownloadToken>();

export const filePreviewSizeLimit = 96 * 1024;
const fileDownloadMaxBytes = config.fileDownloadMaxBytes;
/**
 * The byte limit alone does not bound a download plan: a tree of empty files costs nothing in bytes but
 * retains one entry object per descendant, and the plan then lives in a global token map for minutes.
 * The depth bound additionally stops a compromised node from recursing forever by listing itself as its
 * own child.
 */
export const fileDownloadMaxEntries = config.fileDownloadMaxEntries;
export const fileDownloadMaxDepth = 64;
export const archiveDownloadTokenMaxCount = 64;
export const fileZipLimits = { maxEntries: config.fileZipMaxEntries, maxExpandedBytes: config.fileZipMaxExpandedBytes };
const fileDownloadZipThresholdBytes = config.fileDownloadZipThresholdBytes;
const fileDownloadZipThresholdCount = config.fileDownloadZipThresholdCount;

export function fileLeaseOwner(request: { headers: { cookie?: string } }, user: StoredUser) {
  const sessionId = parseCookies(request.headers.cookie).get(sessionCookieName);
  if (!sessionId) {
    unauthorized("Authentication required");
  }
  return { userId: user.id, sessionId, displayName: user.username };
}

export function fileContentRevision(content: string) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function fileRevisionConflict(): never {
  throwHttp(409, "The file changed after editing began. Reload it before making more changes.", { code: "file_revision_conflict" });
}

export function assertFileRevision(requested: string | undefined, acquired: string, current: string) {
  if (!requested || requested !== acquired || current !== acquired) fileRevisionConflict();
}

export async function readFileWithRevision(runtime: NodeRuntime, server: ManagedServer, target: string) {
  const result = await runtime.readFile(server, target) as { path?: string; content?: string; modifiedAt?: string };
  if (typeof result.content !== "string") throw new Error("File content is unavailable");
  return { ...result, content: result.content, revision: fileContentRevision(result.content) };
}

export function publicFileEditLease(lease: FileEditLease) {
  const { sessionId: _sessionId, ...publicLease } = lease;
  return publicLease;
}

export async function fileEditLockPath(runtime: NodeRuntime, server: ManagedServer, target: string) {
  if (server.nodeId === localNodeId) {
    const [root, realTarget] = await Promise.all([realpath(server.serverDir), realpath(target)]);
    const relativePath = relative(root, realTarget).replaceAll("\\", "/");
    return normalizePublicFilePath(relativePath ? `/${relativePath}` : "/");
  }
  return normalizePublicFilePath(runtime.publicPath(server, target));
}

export function toPublicPath(server: ManagedServer, absolutePath: string) {
  return toPublicServerPath(server, absolutePath);
}

export function isModsPath(server: ManagedServer, absolutePath: string) {
  const publicPath = toPublicPath(server, absolutePath);
  const directory = serverRuntimeDefinition(runtimeTarget(server).runtimeType).contentDirectory;
  return publicPath === `/${directory}` || publicPath.startsWith(`/${directory}/`);
}

export function isServerSettingsFile(server: ManagedServer, absolutePath: string) {
  const publicPath = toPublicPath(server, absolutePath);
  return publicPath === "/server.properties";
}

export function fileRenamePermission(server: ManagedServer, source: string, target: string): Permission {
  if (isServerSettingsFile(server, source) || isServerSettingsFile(server, target)) return "servers.editSettings";
  if (isModsPath(server, source) || isModsPath(server, target)) return "mods.enableDisable";
  return "files.edit";
}

export async function requireFilePathPermission(request: { headers: { cookie?: string } }, server: ManagedServer, absolutePath: string, permission: Permission) {
  if (!isModsPath(server, absolutePath)) {
    return requireRequestPermission(request, permission);
  }
  if (permission === "files.view" || permission === "files.download") {
    return requireRequestPermission(request, "mods.view");
  }
  if (permission === "files.edit") {
    return requireRequestPermission(request, "mods.enableDisable");
  }
  if (permission === "files.upload") {
    return requireRequestPermission(request, "mods.upload");
  }
  if (permission === "files.delete") {
    return requireRequestPermission(request, "mods.remove");
  }
  return requireRequestPermission(request, permission);
}

function fileDownloadLimitError(size: number): never {
  throwHttp(413, `Download is larger than ${Math.floor(fileDownloadMaxBytes / 1024 / 1024)} MiB`, {
    code: "download_size_limit",
    details: { size, limit: fileDownloadMaxBytes }
  });
}

function archiveSegment(name: string) {
  const segment = basename(name).trim().replace(/[^a-zA-Z0-9._ -]/g, "_");
  return segment && segment !== "." && segment !== ".." ? segment : "download";
}

function publicPathParent(path: string) {
  const normalized = normalizePublicFilePath(path);
  if (normalized === "/") return "/";
  const parts = normalized.slice(1).split("/");
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function publicPathName(path: string) {
  const normalized = normalizePublicFilePath(path);
  if (normalized === "/") return "server-files";
  return archiveSegment(normalized.split("/").pop() ?? "download");
}

function publicPathContains(parent: string, child: string) {
  const normalizedParent = normalizePublicFilePath(parent);
  const normalizedChild = normalizePublicFilePath(child);
  return normalizedParent === "/" || normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

export function assertDownloadSize(totalSize: number) {
  if (totalSize > fileDownloadMaxBytes) fileDownloadLimitError(totalSize);
}

export function fileDownloadIntentMode(input: { hasDirectory: boolean; fileCount: number; totalSize: number }) {
  assertDownloadSize(input.totalSize);
  return input.hasDirectory || (input.fileCount > 1 && (input.fileCount >= fileDownloadZipThresholdCount || input.totalSize >= fileDownloadZipThresholdBytes))
    ? "archive"
    : "individual";
}

export function parseFileListing(value: unknown) {
  if (!value || typeof value !== "object") throw new Error("File listing is unavailable");
  const listing = value as { path?: unknown; entries?: unknown };
  if (typeof listing.path !== "string" || !Array.isArray(listing.entries)) throw new Error("File listing is malformed");
  const entries = listing.entries.map((entry) => {
    if (!entry || typeof entry !== "object") throw new Error("File listing entry is malformed");
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.name !== "string" || typeof candidate.path !== "string" || (candidate.type !== "file" && candidate.type !== "directory") || typeof candidate.size !== "number") {
      throw new Error("File listing entry is malformed");
    }
    return {
      name: candidate.name,
      path: normalizePublicFilePath(candidate.path),
      type: candidate.type,
      size: candidate.size,
      modifiedAt: typeof candidate.modifiedAt === "string" ? candidate.modifiedAt : undefined
    } satisfies DownloadIntentEntry;
  });
  return { path: normalizePublicFilePath(listing.path), entries };
}

async function localDownloadSelection(server: ManagedServer, target: string): Promise<DownloadSelection> {
  const targetStat = await lstat(target);
  if (targetStat.isSymbolicLink()) {
    throw new Error("Symlinked files and folders cannot be downloaded");
  }
  const type = targetStat.isDirectory() ? "directory" : targetStat.isFile() ? "file" : undefined;
  if (!type) throw new Error("Only files and folders can be downloaded");
  return {
    name: publicPathName(toPublicPath(server, target)),
    path: normalizePublicFilePath(toPublicPath(server, target)),
    target,
    type,
    size: type === "file" ? targetStat.size : 0,
    modifiedAt: targetStat.mtime.toISOString()
  };
}

async function remoteDownloadSelection(runtime: NodeRuntime, server: ManagedServer, target: string): Promise<DownloadSelection> {
  const publicPath = normalizePublicFilePath(runtime.publicPath(server, target));
  try {
    await runtime.listFiles(server, target);
    return { name: publicPathName(publicPath), path: publicPath, target, type: "directory", size: 0 };
  } catch {
    const parentPath = publicPathParent(publicPath);
    const parentTarget = await runtime.resolveExistingPath(server, parentPath);
    const parentListing = parseFileListing(await runtime.listFiles(server, parentTarget));
    const entry = parentListing.entries.find((candidate) => candidate.path === publicPath);
    if (!entry || entry.type !== "file") throw new Error("Only files and folders can be downloaded");
    return { ...entry, target, name: publicPathName(publicPath) };
  }
}

export async function downloadSelection(runtime: NodeRuntime, server: ManagedServer, target: string): Promise<DownloadSelection> {
  return server.nodeId === localNodeId
    ? localDownloadSelection(server, target)
    : remoteDownloadSelection(runtime, server, target);
}

export function dedupeDownloadSelections(selections: DownloadSelection[]) {
  const sorted = [...selections].sort((left, right) => left.path.length - right.path.length);
  const kept: DownloadSelection[] = [];
  for (const selection of sorted) {
    if (kept.some((candidate) => candidate.type === "directory" && candidate.path !== selection.path && publicPathContains(candidate.path, selection.path))) {
      continue;
    }
    if (!kept.some((candidate) => candidate.path === selection.path)) kept.push(selection);
  }
  return kept.sort((left, right) => left.path.localeCompare(right.path));
}

export async function collectArchiveEntries(
  request: { headers: { cookie?: string } },
  runtime: NodeRuntime,
  server: ManagedServer,
  selection: DownloadSelection,
  archivePath: string,
  entries: FileArchiveEntry[],
  total: { size: number },
  depth = 0
) {
  if (depth > fileDownloadMaxDepth) {
    throw new Error(`Download selection is nested deeper than ${fileDownloadMaxDepth} directories`);
  }
  if (entries.length >= fileDownloadMaxEntries) {
    throw new Error(`Download selection contains more than ${fileDownloadMaxEntries} files and folders`);
  }
  if (server.nodeId === localNodeId) {
    const targetStat = await lstat(selection.target);
    if (targetStat.isSymbolicLink()) throw new Error("Symlinked files and folders cannot be downloaded");
  }
  if (selection.type === "file") {
    total.size += selection.size;
    assertDownloadSize(total.size);
    entries.push({
      sourcePath: selection.target,
      archivePath,
      type: "file",
      size: selection.size,
      modifiedAt: selection.modifiedAt
    });
    return;
  }

  entries.push({
    sourcePath: selection.target,
    archivePath,
    type: "directory",
    size: 0,
    modifiedAt: selection.modifiedAt
  });
  const listing = parseFileListing(await runtime.listFiles(server, selection.target));
  for (const entry of listing.entries) {
    const childTarget = await runtime.resolveExistingPath(server, entry.path);
    await requireFilePathPermission(request, server, childTarget, "files.download");
    const childSelection = server.nodeId === localNodeId
      ? await localDownloadSelection(server, childTarget)
      : { ...entry, target: childTarget };
    await collectArchiveEntries(
      request,
      runtime,
      server,
      childSelection,
      `${archivePath}/${archiveSegment(entry.name)}`,
      entries,
      total,
      depth + 1
    );
  }
}

export async function prepareDownload(
  request: { headers: { cookie?: string } },
  runtime: NodeRuntime,
  server: ManagedServer,
  selections: DownloadSelection[]
): Promise<PreparedDownload> {
  const entries: FileArchiveEntry[] = [];
  const total = { size: 0 };
  const multiple = selections.length > 1;
  for (const selection of selections) {
    const topLevelName = selection.path === "/" ? archiveSegment(server.displayName || "server-files") : archiveSegment(selection.name);
    const archivePath = multiple || selection.type === "directory" ? topLevelName : archiveSegment(selection.name);
    await collectArchiveEntries(request, runtime, server, selection, archivePath, entries, total);
  }
  const baseName = selections.length === 1
    ? selections[0].path === "/" ? server.displayName || "server-files" : selections[0].name
    : `${server.displayName || "server"} files`;
  return { entries, totalSize: total.size, archiveFilename: safeArchiveFilename(baseName) };
}

export function cleanupArchiveDownloadTokens(now = Date.now()) {
  for (const [token, value] of archiveDownloadTokens) {
    if (value.expiresAt <= now) archiveDownloadTokens.delete(token);
  }
}

export function createArchiveDownloadToken(serverId: string, prepared: PreparedDownload) {
  cleanupArchiveDownloadTokens();
  // Tokens live for five minutes, so expiry alone lets a caller hold many plans at once. Retire the
  // oldest once the map is full rather than letting concurrent preparations accumulate without bound.
  while (archiveDownloadTokens.size >= archiveDownloadTokenMaxCount) {
    const oldest = [...archiveDownloadTokens.entries()].reduce((least, entry) => entry[1].expiresAt < least[1].expiresAt ? entry : least);
    archiveDownloadTokens.delete(oldest[0]);
  }
  const token = randomUUID();
  archiveDownloadTokens.set(token, {
    serverId,
    entries: prepared.entries,
    filename: prepared.archiveFilename,
    totalSize: prepared.totalSize,
    expiresAt: Date.now() + 5 * 60 * 1000
  });
  return token;
}

function pathIsInsideRoot(root: string, target: string) {
  const rel = relative(resolve(root), resolve(target));
  return !rel || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function localFilePathInput(server: Pick<ManagedServer, "serverDir">, path: string) {
  const value = path || ".";
  if (isAbsolute(value) && pathIsInsideRoot(server.serverDir, value)) {
    return resolve(value);
  }
  const publicPath = value === "." ? "/" : normalizePublicFilePath(value.startsWith("/") ? value : `/${value}`);
  return publicPath === "/" ? "." : publicPath.slice(1);
}

export function localResolveExistingPath(server: ManagedServer, path: string) {
  return validateExistingInsideServer(server, localFilePathInput(server, path));
}

export function localResolveWritablePath(server: ManagedServer, path: string) {
  return ensureWritableInsideServer(server, localFilePathInput(server, path));
}
