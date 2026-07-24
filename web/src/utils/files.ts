import type { FileEntry } from '../types';

export function parentPath(path: string) {
  if (path === "/") return "/";
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

export function isEditableFile(entry: FileEntry) {
  if (entry.type !== "file" || entry.size > 2 * 1024 * 1024) return false;
  const extension = entry.name.split(".").pop()?.toLowerCase() ?? "";
  const knownBinaryExtensions = new Set([
    "jar", "zip", "gz", "gzip", "tar", "tgz", "7z", "rar", "bz2", "xz",
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svgz",
    "mp3", "ogg", "wav", "flac", "mp4", "webm", "avi", "mov",
    "class", "so", "dll", "dylib", "exe", "bin", "dat", "nbt", "mca", "mcr",
    "db", "sqlite", "sqlite3", "pdf", "woff", "woff2", "ttf", "otf"
  ]);
  return !knownBinaryExtensions.has(extension);
}

export function fileDisplayType(entry: FileEntry) {
  if (entry.type === "directory") return "Folder";
  if (/\.json5?$/i.test(entry.name)) return "JSON File";
  if (/\.properties$/i.test(entry.name)) return "Properties File";
  if (/\.jar(\.disabled)?$/i.test(entry.name)) return "JAR File";
  if (/\.zip$/i.test(entry.name)) return "ZIP Archive";
  if (/\.log$/i.test(entry.name)) return "Log File";
  if (/\.(txt|md|csv|env|log|mcfunction|lang|list)$/i.test(entry.name)) return "Text Document";
  if (/\.(toml|ya?ml|cfg|conf|ini|xml|mcmeta)$/i.test(entry.name)) return "Config File";
  return "Unknown File";
}

export function fileStatusLabel(entry: FileEntry) {
  if (entry.status === "locked") return "Locked";
  if (entry.status === "binary") return "Binary";
  if (entry.status === "too_large") return "Too large";
  if (entry.status === "unknown") return "Unknown";
  return "OK";
}

export function isPreviewableFile(entry: FileEntry) {
  return entry.type === "file" && isEditableFile({ ...entry, size: Math.min(entry.size, 2 * 1024 * 1024) });
}

export function joinPublicPath(parent: string, name: string) {
  const cleanParent = parent === "/" ? "" : parent.replace(/\/+$/, "");
  return `${cleanParent}/${name}`.replace(/\/+/g, "/");
}

export function fileIconKind(entry: FileEntry) {
  if (entry.type === "directory") return "folder";
  if (/\.jar$/i.test(entry.name)) return "jar";
  if (/\.zip$/i.test(entry.name)) return "archive";
  if (/\.(log|txt|md|csv|env|mcfunction|lang|list)$/i.test(entry.name)) return "text";
  if (/\.(properties|json5?|ya?ml|toml|cfg|conf|ini|xml|mcmeta)$/i.test(entry.name)) return "config";
  return "file";
}

export function clientId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
