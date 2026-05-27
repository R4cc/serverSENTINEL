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
  return ["txt", "json", "json5", "properties", "toml", "yml", "yaml", "cfg", "conf", "log", "md", "csv", "env"].includes(extension)
    || !entry.name.includes(".");
}

export function fileIconKind(entry: FileEntry) {
  if (entry.type === "directory") return "folder";
  if (/\.jar$/i.test(entry.name)) return "jar";
  if (/\.(log|txt|md|csv|env)$/i.test(entry.name)) return "text";
  if (/\.(properties|json5?|ya?ml|toml|cfg|conf)$/i.test(entry.name)) return "config";
  return "file";
}

export function bufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return window.btoa(binary);
}

export function clientId() {
  return globalThis.crypto?.randomUUID?.() ?? `id-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
