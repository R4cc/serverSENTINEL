import type { FileEntry } from "../../types";
import { joinPublicPath, parentPath } from "../../utils/files";
import { publicPathContains } from "../../utils/appHelpers";

export function fileMoveTargetPath(entry: FileEntry, destinationPath: string) {
  return joinPublicPath(destinationPath, entry.name);
}

export function isFileMoveDestination(entry: FileEntry, destinationPath: string) {
  if (parentPath(entry.path) === destinationPath) return false;
  return entry.type !== "directory" || !publicPathContains(entry.path, destinationPath);
}

export function moveDemoFileTree(files: Record<string, string>, sourcePath: string, targetPath: string) {
  const nextFiles = { ...files };
  for (const path of Object.keys(nextFiles)) {
    if (path !== sourcePath && !path.startsWith(`${sourcePath}/`)) continue;
    const replacement = `${targetPath}${path.slice(sourcePath.length)}`;
    nextFiles[replacement] = nextFiles[path];
    delete nextFiles[path];
  }
  return nextFiles;
}
