import { createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm, utimes } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl, { type Entry, type ZipFile } from "yauzl";

export type ZipArchiveLimits = {
  maxEntries: number;
  maxExpandedBytes: number;
};

export type ZipArchiveEntry = {
  name: string;
  path: string;
  type: "directory" | "file";
  size: number;
  compressedSize: number;
  modifiedAt: string;
  encrypted?: boolean;
  unsupported?: boolean;
};

export type ZipArchiveListing = {
  archivePath: string;
  path: string;
  readOnly: true;
  encrypted: boolean;
  entries: ZipArchiveEntry[];
};

export type ZipExtractionConflict = {
  path: string;
  kind: "file" | "type" | "symlink";
};

export type ZipExtractionPlan = {
  archivePath: string;
  destinationPath: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
  outputPaths: Array<{ path: string; type: "directory" | "file" }>;
  conflicts: ZipExtractionConflict[];
  blocked: ZipExtractionConflict[];
};

export type ZipExtractionResult = {
  destinationPath: string;
  extractedFiles: number;
  createdDirectories: number;
  replacedFiles: number;
  skippedFiles: number;
  totalBytes: number;
};

type IndexedEntry = ZipArchiveEntry & {
  rawName: string;
  rawEntry?: Entry;
  unsafeLink: boolean;
};

type ZipIndex = {
  entries: IndexedEntry[];
  encrypted: boolean;
  totalBytes: number;
};

function zipError(message: string, code = "invalid_zip_archive") {
  const error = new Error(message) as Error & { code?: string; statusCode?: number };
  error.code = code;
  error.statusCode = 400;
  return error;
}

function normalizedEntryName(rawName: string) {
  if (!rawName || rawName.includes("\0") || rawName.includes("\\") || rawName.startsWith("/") || /^[a-zA-Z]:/.test(rawName)) {
    throw zipError(`Archive entry ${JSON.stringify(rawName)} has an unsafe path`);
  }
  const directory = rawName.endsWith("/");
  const value = directory ? rawName.slice(0, -1) : rawName;
  const parts = value.split("/");
  if (!value || parts.some((part) => !part || part === "." || part === "..")) {
    throw zipError(`Archive entry ${JSON.stringify(rawName)} is not normalized`);
  }
  return { path: parts.join("/"), directory };
}

export function normalizeZipEntryPath(input: unknown, allowRoot = true) {
  if (typeof input !== "string") throw zipError("Archive entry path must be a string");
  if (input.includes("\0") || input.includes("\\")) throw zipError("Archive entry path contains invalid characters");
  const value = input.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!value) {
    if (allowRoot) return "";
    throw zipError("An archive entry path is required");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw zipError("Archive entry path must be normalized");
  return parts.join("/");
}

function unixMode(entry: Entry) {
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function unsafeLink(entry: Entry) {
  return (unixMode(entry) & 0o170000) === 0o120000;
}

function openZip(path: string, options: yauzl.Options = { lazyEntries: true, autoClose: false }) {
  return new Promise<ZipFile>((resolvePromise, reject) => {
    yauzl.open(path, options, (error, zip) => error || !zip ? reject(error ?? zipError("Could not open ZIP archive")) : resolvePromise(zip));
  });
}

function readZipEntries(zip: ZipFile) {
  return new Promise<Entry[]>((resolvePromise, reject) => {
    const entries: Entry[] = [];
    const fail = (error: Error) => {
      zip.close();
      reject(error);
    };
    zip.on("error", fail);
    zip.on("entry", (entry) => {
      entries.push(entry);
      zip.readEntry();
    });
    zip.on("end", () => {
      zip.close();
      resolvePromise(entries);
    });
    zip.readEntry();
  });
}

export async function indexZipArchive(archivePath: string, limits: ZipArchiveLimits): Promise<ZipIndex> {
  const rawEntries = await readZipEntries(await openZip(archivePath));
  if (rawEntries.length > limits.maxEntries) throw zipError(`ZIP archive contains more than ${limits.maxEntries} entries`, "zip_entry_limit");
  const entries: IndexedEntry[] = [];
  const explicit = new Set<string>();
  const implicitDirectories = new Map<string, IndexedEntry>();
  let totalBytes = 0;
  let encrypted = false;

  for (const raw of rawEntries) {
    const normalized = normalizedEntryName(raw.fileName);
    if (explicit.has(normalized.path)) throw zipError(`ZIP archive contains duplicate entry ${normalized.path}`);
    explicit.add(normalized.path);
    const isEncrypted = (raw.generalPurposeBitFlag & 1) !== 0;
    const unsupported = !normalized.directory && raw.compressionMethod !== 0 && raw.compressionMethod !== 8;
    const entry: IndexedEntry = {
      name: basename(normalized.path),
      path: normalized.path,
      rawName: raw.fileName,
      rawEntry: raw,
      type: normalized.directory ? "directory" : "file",
      size: normalized.directory ? 0 : raw.uncompressedSize,
      compressedSize: normalized.directory ? 0 : raw.compressedSize,
      modifiedAt: raw.getLastModDate().toISOString(),
      encrypted: isEncrypted || undefined,
      unsupported: unsupported || undefined,
      unsafeLink: unsafeLink(raw)
    };
    if (entry.unsafeLink) throw zipError(`ZIP archive entry ${entry.path} is a symbolic link`);
    totalBytes += entry.size;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxExpandedBytes) {
      throw zipError(`ZIP archive expands beyond ${limits.maxExpandedBytes} bytes`, "zip_expanded_size_limit");
    }
    encrypted ||= isEncrypted;
    entries.push(entry);

    const parts = normalized.path.split("/");
    parts.pop();
    while (parts.length) {
      const path = parts.join("/");
      if (!implicitDirectories.has(path)) {
        implicitDirectories.set(path, {
          name: basename(path),
          path,
          rawName: "",
          type: "directory",
          size: 0,
          compressedSize: 0,
          modifiedAt: entry.modifiedAt,
          unsafeLink: false
        });
      }
      parts.pop();
    }
  }

  for (const [path, directory] of implicitDirectories) {
    if (!explicit.has(path)) entries.push(directory);
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { entries, encrypted, totalBytes };
}

export async function listZipArchive(archivePath: string, entryPath: string, limits: ZipArchiveLimits): Promise<ZipArchiveListing> {
  const index = await indexZipArchive(archivePath, limits);
  const current = normalizeZipEntryPath(entryPath);
  if (current && !index.entries.some((entry) => entry.path === current && entry.type === "directory")) {
    throw zipError("Archive folder was not found", "zip_entry_not_found");
  }
  const prefix = current ? `${current}/` : "";
  const entries = index.entries
    .filter((entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes("/") && entry.path !== current)
    .sort((left, right) => Number(right.type === "directory") - Number(left.type === "directory") || left.name.localeCompare(right.name))
    .map(({ rawName: _rawName, rawEntry: _rawEntry, unsafeLink: _unsafeLink, ...entry }) => ({ ...entry, path: `/${entry.path}` }));
  return { archivePath, path: current ? `/${current}` : "/", readOnly: true, encrypted: index.encrypted, entries };
}

async function findRawEntry(archivePath: string, entryPath: string, limits: ZipArchiveLimits) {
  const normalized = normalizeZipEntryPath(entryPath, false);
  const index = await indexZipArchive(archivePath, limits);
  const entry = index.entries.find((candidate) => candidate.path === normalized && candidate.type === "file");
  if (!entry || !entry.rawName) throw zipError("Archive file was not found", "zip_entry_not_found");
  if (entry.encrypted) throw zipError("Encrypted ZIP entries are not supported", "zip_encrypted");
  if (entry.unsupported) throw zipError("This ZIP compression method is not supported", "zip_compression_unsupported");
  return entry;
}

export async function openZipArchiveEntryStream(archivePath: string, entryPath: string, limits: ZipArchiveLimits) {
  const target = await findRawEntry(archivePath, entryPath, limits);
  return openIndexedZipEntryStream(archivePath, target);
}

async function openIndexedZipEntryStream(archivePath: string, target: IndexedEntry) {
  if (!target.rawEntry) throw zipError("Archive file was not found", "zip_entry_not_found");
  const rawEntry = target.rawEntry;
  const zip = await openZip(archivePath);
  return new Promise<{ entry: ZipArchiveEntry; stream: NodeJS.ReadableStream }>((resolvePromise, reject) => {
    const fail = (error: Error) => {
      reject(error);
      zip.close();
    };
    zip.on("error", fail);
    zip.openReadStream(rawEntry, (error, stream) => {
      if (error || !stream) return fail(error ?? zipError("Could not read archive entry"));
      stream.once("end", () => zip.close());
      stream.once("error", () => zip.close());
      const { rawName: _rawName, rawEntry: _rawEntry, unsafeLink: _unsafeLink, ...publicEntry } = target;
      resolvePromise({ entry: publicEntry, stream });
    });
  });
}

export async function readZipArchiveEntry(archivePath: string, entryPath: string, limits: ZipArchiveLimits, maxBytes: number) {
  const opened = await openZipArchiveEntryStream(archivePath, entryPath, limits);
  if (opened.entry.size > maxBytes) throw zipError(`Archive entry is larger than ${maxBytes} bytes`, "zip_entry_size_limit");
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return { entry: opened.entry, content: Buffer.concat(chunks) };
}

async function existingStat(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function hasSymlinkAncestor(destination: string, target: string) {
  let current = resolve(destination);
  const final = resolve(target);
  while (current.length <= final.length) {
    const stat = await existingStat(current);
    if (stat?.isSymbolicLink()) return true;
    if (current === final) break;
    const relative = final.slice(current.length).replace(/^[\\/]+/, "");
    const next = relative.split(/[\\/]/)[0];
    if (!next) break;
    current = join(current, next);
  }
  return false;
}

export async function planZipExtraction(archivePath: string, destinationPath: string, limits: ZipArchiveLimits): Promise<ZipExtractionPlan> {
  const index = await indexZipArchive(archivePath, limits);
  const conflicts: ZipExtractionConflict[] = [];
  const blocked: ZipExtractionConflict[] = [];
  for (const entry of index.entries) {
    const target = join(destinationPath, ...entry.path.split("/"));
    if (await hasSymlinkAncestor(destinationPath, target)) {
      blocked.push({ path: target, kind: "symlink" });
      continue;
    }
    const stat = await existingStat(target);
    if (!stat) continue;
    if (entry.type === "directory" && stat.isDirectory()) continue;
    if (entry.type === "file" && stat.isFile()) conflicts.push({ path: target, kind: "file" });
    else blocked.push({ path: target, kind: stat.isSymbolicLink() ? "symlink" : "type" });
  }
  if (index.entries.some((entry) => entry.encrypted)) blocked.push({ path: archivePath, kind: "type" });
  if (index.entries.some((entry) => entry.unsupported)) blocked.push({ path: archivePath, kind: "type" });
  return {
    archivePath,
    destinationPath,
    fileCount: index.entries.filter((entry) => entry.type === "file").length,
    directoryCount: index.entries.filter((entry) => entry.type === "directory").length,
    totalBytes: index.totalBytes,
    outputPaths: index.entries.map((entry) => ({ path: join(destinationPath, ...entry.path.split("/")), type: entry.type })),
    conflicts,
    blocked
  };
}

export async function extractZipArchive(input: {
  archivePath: string;
  destinationPath: string;
  conflictPolicy: "replace" | "skip";
  limits: ZipArchiveLimits;
  report?: (progress: number, task: string) => void;
}): Promise<ZipExtractionResult> {
  const plan = await planZipExtraction(input.archivePath, input.destinationPath, input.limits);
  if (plan.blocked.length) throw zipError(`ZIP extraction is blocked by ${plan.blocked[0].path}`, "zip_extraction_blocked");
  const conflictPaths = new Set(plan.conflicts.map((entry) => resolve(entry.path)));
  const index = await indexZipArchive(input.archivePath, input.limits);
  await mkdir(input.destinationPath, { recursive: true });
  let createdDirectories = 0;
  let extractedFiles = 0;
  let replacedFiles = 0;
  let skippedFiles = 0;
  let completedBytes = 0;

  for (const directory of index.entries.filter((entry) => entry.type === "directory").sort((a, b) => a.path.length - b.path.length)) {
    const target = join(input.destinationPath, ...directory.path.split("/"));
    if (!await existingStat(target)) {
      await mkdir(target, { recursive: false });
      createdDirectories += 1;
    }
  }

  for (const entry of index.entries.filter((candidate) => candidate.type === "file")) {
    const target = join(input.destinationPath, ...entry.path.split("/"));
    const conflict = conflictPaths.has(resolve(target));
    if (conflict && input.conflictPolicy === "skip") {
      skippedFiles += 1;
      completedBytes += entry.size;
      input.report?.(Math.round((completedBytes / Math.max(plan.totalBytes, 1)) * 100), `Skipping ${entry.path}`);
      continue;
    }
    await mkdir(dirname(target), { recursive: true });
    const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const temporary = join(dirname(target), `.${basename(target)}.extract-${suffix}.tmp`);
    const backup = join(dirname(target), `.${basename(target)}.extract-${suffix}.bak`);
    try {
      if (entry.encrypted) throw zipError(`Archive entry ${entry.path} is encrypted`, "zip_encrypted");
      if (entry.unsupported) throw zipError(`Archive entry ${entry.path} uses an unsupported compression method`, "zip_compression_unsupported");
      const opened = await openIndexedZipEntryStream(input.archivePath, entry);
      await pipeline(opened.stream, createWriteStream(temporary, { flags: "wx" }));
      if (conflict) await rename(target, backup);
      try {
        await rename(temporary, target);
      } catch (error) {
        if (conflict) await rename(backup, target).catch(() => undefined);
        throw error;
      }
      if (conflict) {
        await rm(backup, { force: true });
        replacedFiles += 1;
      }
      const modified = new Date(entry.modifiedAt);
      if (!Number.isNaN(modified.getTime())) await utimes(target, modified, modified).catch(() => undefined);
      extractedFiles += 1;
      completedBytes += entry.size;
      input.report?.(Math.round((completedBytes / Math.max(plan.totalBytes, 1)) * 100), `Extracting ${entry.path}`);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
      if (await existingStat(backup)) await rename(backup, target).catch(() => rm(backup, { force: true }));
    }
  }
  input.report?.(100, "Extraction complete");
  return { destinationPath: input.destinationPath, extractedFiles, createdDirectories, replacedFiles, skippedFiles, totalBytes: completedBytes };
}
