import { basename } from "node:path";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";
import { openContainedReadStream } from "./core.js";

export type FileArchiveEntry = {
  sourcePath: string;
  archivePath: string;
  type: "file" | "directory";
  size: number;
  modifiedAt?: string;
};

export function safeArchiveFilename(name: string) {
  const filename = basename(name).trim().replace(/\.zip$/i, "") || "download";
  return `${filename.replace(/[^a-zA-Z0-9._ -]/g, "_")}.zip`;
}

export function safeArchivePath(path: string) {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "").replace(/\/+$/g, "");
  if (!normalized || normalized.includes("\0") || /[\r\n]/.test(normalized)) {
    throw new Error("Archive path contains invalid characters");
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("Archive path must be normalized");
  }
  return segments.join("/");
}

export type ZipArchiveStreamOptions = {
  /**
   * File downloads stay stored so the archive size is predictable enough to announce up front. An
   * export is spooled to disk and measured afterwards, so it can afford to deflate -- which matters
   * a great deal for a world folder of region and NBT data.
   */
  compress?: boolean;
};

/**
 * Archive members are opened lazily, long after the plan was validated, so each one is opened without
 * following a final-component symlink rather than reopened by name with whatever it now points at.
 */
export function createZipArchiveStream(
  entries: FileArchiveEntry[],
  openStream: (entry: FileArchiveEntry) => Promise<Readable> = async (entry) => (await openContainedReadStream(entry.sourcePath)).stream,
  options: ZipArchiveStreamOptions = {}
) {
  const compress = options.compress === true;
  const zip = new ZipFile();
  for (const entry of entries) {
    const archivePath = safeArchivePath(entry.archivePath);
    const mtime = entry.modifiedAt ? new Date(entry.modifiedAt) : undefined;
    if (entry.type === "directory") {
      zip.addEmptyDirectory(archivePath, mtime && !Number.isNaN(mtime.getTime()) ? { mtime } : undefined);
      continue;
    }
    zip.addReadStreamLazy(
      archivePath,
      {
        ...(mtime && !Number.isNaN(mtime.getTime()) ? { mtime } : {}),
        compress,
        size: entry.size
      },
      (callback) => {
        openStream(entry)
          .then((stream) => callback(null, stream))
          .catch((error) => callback(error, Readable.from([])));
      }
    );
  }
  zip.end();
  return zip.outputStream as Readable;
}
