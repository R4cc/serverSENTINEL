import type { FileArchiveEntry } from "./downloadArchive.js";

const fastCompressionThresholdBytes = 1024 * 1024;
const precompressedExportSuffix = /\.(?:7z|bz2|gif|gz|jar|jpe?g|mp3|mp4|ogg|png|rar|webm|webp|xz|zip|zst)(?:\.disabled)?$/i;

/** Shared by panel-side exports and the remote-node export fast path. */
export function exportArchiveCompressionLevel(entry: FileArchiveEntry) {
  if (precompressedExportSuffix.test(entry.archivePath)) return 0;
  if (entry.size >= fastCompressionThresholdBytes) return 1;
  return 6;
}
