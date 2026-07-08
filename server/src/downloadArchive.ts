import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { ZipFile } from "yazl";

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

export function createZipArchiveStream(
  entries: FileArchiveEntry[],
  openStream: (entry: FileArchiveEntry) => Promise<Readable> = async (entry) => createReadStream(entry.sourcePath)
) {
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
        compress: false,
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
