import { stat } from "node:fs/promises";
import { join } from "node:path";

export const cachedIconExtensions = [".webp", ".jpg", ".jpeg", ".png", ".gif"] as const;

function isMissingPathError(error: unknown) {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

export function cachedIconFilenames(key: string) {
  return cachedIconExtensions.map((extension) => `${key}${extension}`);
}

export async function findCachedIconFile(directory: string, key: string) {
  for (const filename of cachedIconFilenames(key)) {
    const path = join(directory, filename);
    try {
      const fileStat = await stat(path);
      if (fileStat.isFile()) return { filename, path, mtimeMs: fileStat.mtimeMs };
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  return null;
}
