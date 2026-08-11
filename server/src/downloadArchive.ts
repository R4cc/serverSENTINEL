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
  /**
   * Selects a zlib level globally or per archive member. Level 0 stores bytes without DEFLATE.
   * When set, this takes precedence over `compress` so callers can mix stored and compressed members.
   */
  compressionLevel?: number | ((entry: FileArchiveEntry) => number);
};

function compressionOptions(entry: FileArchiveEntry, options: ZipArchiveStreamOptions) {
  const compressionLevel = typeof options.compressionLevel === "function"
    ? options.compressionLevel(entry)
    : options.compressionLevel;
  return compressionLevel === undefined ? { compress: options.compress === true } : { compressionLevel };
}

/**
 * Archive members are opened lazily, long after the plan was validated, so each one is opened without
 * following a final-component symlink rather than reopened by name with whatever it now points at.
 */
export function createZipArchiveStream(
  entries: FileArchiveEntry[],
  openStream: (entry: FileArchiveEntry) => Promise<Readable> = async (entry) => (await openContainedReadStream(entry.sourcePath)).stream,
  options: ZipArchiveStreamOptions = {}
) {
  const zip = new ZipFile();
  const output = zip.outputStream as Readable;
  // yazl reports a failed member on the ZipFile itself and pipes member streams with `pipe`, which
  // forwards neither the error nor the destruction. Nothing listened on either, so a node dropping
  // mid-transfer raised an unhandled 'error' event and exited the panel process instead of failing
  // the export. Route both onto the archive stream so the consumer's pipeline rejects with the cause.
  zip.on("error", (error: Error) => {
    if (!output.destroyed) output.destroy(error);
  });
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
        ...compressionOptions(entry, options),
        size: entry.size
      },
      (callback) => {
        openStream(entry)
          .then((stream) => {
            // An earlier member already failed the archive; opening this one further would strand a
            // remote transfer that nothing will ever read.
            if (output.destroyed) {
              stream.destroy();
              return;
            }
            stream.once("error", (error: Error) => zip.emit("error", error));
            callback(null, stream);
          })
          .catch((error) => callback(error, Readable.from([])));
      }
    );
  }
  zip.end();
  return output;
}
