import { createWriteStream, existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readdir, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureWritableResolvedInsideServer, openContainedFile, type ServerPathScope } from "../../core.js";
import type { ZipExtractionPlan } from "../../zipArchive.js";

/**
 * Filesystem mechanics for a managed server directory, shared by the panel's
 * local runtime handlers and the node agent's command handler. Callers resolve
 * and authorize paths first, then hand absolute paths to these operations.
 */

export const editorFileSizeLimit = 2 * 1024 * 1024;
export const fileUploadSizeLimit = 256 * 1024 * 1024;

export type FileEntryStatus = "ok" | "too_large" | "binary" | "unknown";

export type UploadSource = {
  stream: NodeJS.ReadableStream;
  size?: number;
};

export function toPublicServerPath(scope: ServerPathScope, absolutePath: string) {
  const rel = relative(resolve(scope.serverDir), absolutePath).replaceAll("\\", "/");
  return rel ? `/${rel}` : "/";
}

function hasUnsafeFileNameCharacter(name: string) {
  return /[<>:"/\\|?*]/.test(name) || [...name].some((character) => character.charCodeAt(0) < 32);
}

export function safeFileManagerName(name?: string) {
  const filename = basename(name ?? "").trim();
  if (!filename || filename !== name || filename === "." || filename === "..") {
    throw new Error("A valid file or folder name is required");
  }
  if (filename.length > 160 || hasUnsafeFileNameCharacter(filename)) {
    throw new Error("File or folder name contains unsafe characters");
  }
  return filename;
}

export function isTextLikeServerFile(name: string) {
  return /\.(txt|json5?|properties|toml|ya?ml|cfg|conf|log|md|csv|env)$/i.test(name) || !name.includes(".");
}

export function fileManagerStatus(entryStat: Awaited<ReturnType<typeof lstat>>, name: string): FileEntryStatus {
  if (entryStat.isDirectory()) return "ok";
  if (!entryStat.isFile()) return "unknown";
  if (entryStat.size > editorFileSizeLimit) return "too_large";
  if (!isTextLikeServerFile(name)) return "binary";
  return "ok";
}

export function publicZipExtractionPlan(scope: ServerPathScope, plan: ZipExtractionPlan): ZipExtractionPlan {
  const publicPath = (value: string) => toPublicServerPath(scope, value);
  return {
    ...plan,
    archivePath: publicPath(plan.archivePath),
    destinationPath: publicPath(plan.destinationPath),
    outputPaths: plan.outputPaths.map((entry) => ({ ...entry, path: publicPath(entry.path) })),
    conflicts: plan.conflicts.map((entry) => ({ ...entry, path: publicPath(entry.path) })),
    blocked: plan.blocked.map((entry) => ({ ...entry, path: publicPath(entry.path) }))
  };
}

export async function listServerDirectory(
  scope: ServerPathScope,
  target: string,
  options: { status?: (entryStat: Awaited<ReturnType<typeof lstat>>, name: string) => string } = {}
) {
  const targetStat = await stat(target);
  if (!targetStat.isDirectory()) {
    throw new Error("Path is not a directory");
  }
  const entries = await readdir(target, { withFileTypes: true });
  return {
    path: toPublicServerPath(scope, target),
    entries: await Promise.all(
      entries
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
        .map(async (entry) => {
          const absolutePath = join(target, entry.name);
          const entryStat = await lstat(absolutePath);
          return {
            name: entry.name,
            path: toPublicServerPath(scope, absolutePath),
            type: entry.isDirectory() ? "directory" : "file",
            size: entryStat.size,
            modifiedAt: entryStat.mtime.toISOString(),
            status: options.status ? options.status(entryStat, entry.name) : fileManagerStatus(entryStat, entry.name)
          };
        })
    )
  };
}

/**
 * Preview semantics differ between callers: the panel previews only small
 * text-like files, while the node agent previews anything under the editor
 * limit. Both share the same response envelope.
 */
export async function previewServerFile(
  scope: ServerPathScope,
  target: string,
  options: { sizeLimit: number; requireTextLike: boolean }
) {
  const path = toPublicServerPath(scope, target);
  // One resolution: the size check and the read both refer to the inode this handle opened, so a
  // workload cannot swap the file for a symlink after the check and have the read follow it.
  const handle = await openContainedFile(target);
  try {
    const targetStat = await handle.stat();
    if (!targetStat.isFile() || (options.requireTextLike && !isTextLikeServerFile(basename(target)))) {
      return { path, preview: "unsupported", message: "Preview unavailable" };
    }
    if (targetStat.size > options.sizeLimit) {
      return { path, preview: "too_large", message: "File too large to preview" };
    }
    const buffer = await handle.readFile();
    if (buffer.includes(0)) {
      return { path, preview: "binary", message: "Preview unavailable" };
    }
    return {
      path,
      preview: "text",
      content: buffer.toString("utf8"),
      modifiedAt: targetStat.mtime.toISOString()
    };
  } finally {
    await handle.close();
  }
}

export async function readServerTextFile(
  scope: ServerPathScope,
  target: string,
  options: { onRejected?: (reason: "editor_size_limit" | "binary_file", path: string, size: number) => void } = {}
) {
  const path = toPublicServerPath(scope, target);
  const handle = await openContainedFile(target);
  try {
    const targetStat = await handle.stat();
    if (!targetStat.isFile()) {
      throw new Error("Path is not a file");
    }
    if (targetStat.size > editorFileSizeLimit) {
      options.onRejected?.("editor_size_limit", path, targetStat.size);
      throw new Error("File is larger than the 2 MiB editor limit");
    }
    const buffer = await handle.readFile();
    if (buffer.includes(0)) {
      options.onRejected?.("binary_file", path, targetStat.size);
      throw new Error("Binary files cannot be edited in the browser editor");
    }
    return {
      path,
      content: buffer.toString("utf8"),
      modifiedAt: targetStat.mtime.toISOString()
    };
  } finally {
    await handle.close();
  }
}

export async function writeServerTextFile(scope: ServerPathScope, target: string, content: unknown) {
  if (typeof content !== "string") {
    throw new Error("Content is required");
  }
  if (Buffer.byteLength(content, "utf8") > editorFileSizeLimit) {
    throw new Error("File content is larger than the 2 MiB editor limit");
  }
  if (content.includes("\0")) {
    throw new Error("Binary files cannot be edited in the browser editor");
  }
  const targetStat = await stat(target);
  if (!targetStat.isFile()) {
    throw new Error("Path is not a file");
  }
  await replaceFileAtomically(target, (temporary) => writeFile(temporary, content, "utf8"));
  return { ok: true, path: toPublicServerPath(scope, target) };
}

export async function createServerFolder(scope: ServerPathScope, parent: string, name: unknown) {
  const parentStat = await stat(parent);
  if (!parentStat.isDirectory()) {
    throw new Error("Parent path is not a directory");
  }
  const target = await ensureWritableResolvedInsideServer(scope, join(parent, safeFileManagerName(name as string | undefined)));
  if (existsSync(target)) {
    throw new Error("A file or folder with that name already exists");
  }
  await mkdir(target, { recursive: false });
  return { ok: true, path: toPublicServerPath(scope, target) };
}

export async function renameServerEntry(scope: ServerPathScope, source: string, name: unknown) {
  if (resolve(source) === resolve(scope.serverDir)) {
    throw new Error("Refusing to rename the server root directory");
  }
  const target = await ensureWritableResolvedInsideServer(scope, join(dirname(source), safeFileManagerName(name as string | undefined)));
  if (existsSync(target)) {
    throw new Error("A file or folder with that name already exists");
  }
  await rename(source, target);
  return { ok: true, path: toPublicServerPath(scope, target) };
}

/**
 * `beforeApply` runs after every path check but before the rename, so callers
 * that gate on runtime state report path errors ahead of state errors.
 */
export async function moveServerEntry(
  scope: ServerPathScope,
  source: string,
  destinationParent: string,
  options: { beforeApply?: () => Promise<void> } = {}
) {
  if (resolve(source) === resolve(scope.serverDir)) {
    throw new Error("Refusing to move the server root directory");
  }
  const destinationStat = await stat(destinationParent);
  if (!destinationStat.isDirectory()) {
    throw new Error("Move destination is not a directory");
  }
  const target = await ensureWritableResolvedInsideServer(scope, join(destinationParent, basename(source)));
  const targetRelativeToSource = relative(source, target);
  if (!targetRelativeToSource) {
    throw new Error("Item is already in that folder");
  }
  if (!isAbsolute(targetRelativeToSource) && targetRelativeToSource !== ".." && !targetRelativeToSource.startsWith(`..${sep}`)) {
    throw new Error("A folder cannot be moved into itself");
  }
  if (existsSync(target)) {
    throw new Error("A file or folder with that name already exists");
  }
  await options.beforeApply?.();
  await rename(source, target);
  return { ok: true, path: toPublicServerPath(scope, target) };
}

export async function copyServerFile(scope: ServerPathScope, source: string, parent: string, name: unknown) {
  const sourceStat = await stat(source);
  if (!sourceStat.isFile()) {
    throw new Error("Only files can be duplicated from the browser file manager");
  }
  const parentStat = await stat(parent);
  if (!parentStat.isDirectory()) {
    throw new Error("Parent path is not a directory");
  }
  const target = await ensureWritableResolvedInsideServer(scope, join(parent, safeFileManagerName(name as string | undefined)));
  if (existsSync(target)) {
    throw new Error("A file or folder with that name already exists");
  }
  await copyFile(source, target);
  return { ok: true, path: toPublicServerPath(scope, target) };
}

export async function deleteServerEntry(scope: ServerPathScope, target: string, recursive: unknown) {
  if (recursive !== undefined && recursive !== "true" && recursive !== "false") {
    throw new Error("recursive must be true or false");
  }
  if (resolve(target) === resolve(scope.serverDir)) {
    throw new Error("Refusing to delete the server root directory");
  }
  const path = toPublicServerPath(scope, target);
  const targetStat = await stat(target);
  if (targetStat.isDirectory()) {
    if (recursive === "true") {
      await rm(target, { recursive: true, force: false });
    } else {
      try {
        await rmdir(target);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOTEMPTY" || code === "EEXIST") {
          throw new Error("Directory is not empty. Recursive deletion requires recursive=true and explicit confirmation.");
        }
        throw error;
      }
    }
  } else if (targetStat.isFile()) {
    await rm(target, { force: false });
  } else {
    throw new Error("Only files and directories can be deleted from the browser file manager");
  }
  return { ok: true, path };
}

/** Resolves the destination for an upload into an existing directory. */
export async function resolveUploadTarget(scope: ServerPathScope, parent: string, filename: unknown) {
  const parentStat = await stat(parent);
  if (!parentStat.isDirectory()) {
    throw new Error("Upload path is not a directory");
  }
  const target = await ensureWritableResolvedInsideServer(scope, join(parent, safeFileManagerName(filename as string | undefined)));
  if (existsSync(target)) {
    throw new Error("A file or folder with that name already exists");
  }
  return target;
}

function isUploadSource(value: unknown): value is UploadSource {
  return Boolean(value && typeof value === "object" && "stream" in value && (value as UploadSource).stream);
}

/**
 * Writes an upload to a sibling temporary file and renames it into place, so a
 * failed or oversized transfer never leaves a partial file at the target path.
 */
export async function writeRuntimeUpload(
  target: string,
  input: UploadSource,
  options: {
    maximumBytes: number;
    allowEmpty: boolean;
    label: string;
    validateTemporary?: (path: string) => Promise<void>;
  }
) {
  const { maximumBytes, allowEmpty, label } = options;
  const sizeRange = `${label} must be between ${allowEmpty ? 0 : 1} bytes and ${Math.floor(maximumBytes / 1024 / 1024)} MiB`;
  return replaceFileAtomically(target, async (temporary) => {
    let size = 0;
    if (!isUploadSource(input)) throw new Error(`${label} must be a streamed upload`);
    if (input.size !== undefined && (!Number.isSafeInteger(input.size) || input.size < (allowEmpty ? 0 : 1) || input.size > maximumBytes)) {
      throw new Error(sizeRange);
    }
    const counter = new Transform({
      transform(chunk, _encoding, callback) {
        size += Buffer.byteLength(chunk);
        callback(size > maximumBytes ? new Error(`${label} is larger than ${Math.floor(maximumBytes / 1024 / 1024)} MiB`) : undefined, chunk);
      }
    });
    await pipeline(input.stream, counter, createWriteStream(temporary, { flags: "wx" }));
    if (input.size !== undefined && input.size !== size) throw new Error(`${label} declared ${input.size} bytes but streamed ${size}`);
    if (!allowEmpty && size === 0) throw new Error(`${label} cannot be empty`);
    await options.validateTemporary?.(temporary);
    return size;
  });
}

async function replaceFileAtomically<T>(target: string, write: (temporary: string) => Promise<T>) {
  const temporary = `${target}.serversentinel-${randomUUID()}.tmp`;
  try {
    const result = await write(temporary);
    await rename(temporary, target);
    return result;
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
