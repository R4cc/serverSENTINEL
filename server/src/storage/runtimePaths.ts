import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const defaultRuntimeDataDir = "/data";

export type RuntimeDataPaths = {
  dataDir: string;
  databasePath: string;
  serversDir: string;
  backupsDir: string;
  importsDir: string;
  exportsDir: string;
  tmpDir: string;
  nodeUpdatesDir: string;
};

export function resolveRuntimeDataDir(value?: string) {
  const trimmed = value?.trim();
  return resolve(trimmed || defaultRuntimeDataDir);
}

export function runtimeDataPaths(dataDirInput?: string): RuntimeDataPaths {
  const dataDir = resolveRuntimeDataDir(dataDirInput);
  const tmpDir = join(dataDir, "tmp");
  return {
    dataDir,
    databasePath: join(dataDir, "serversentinel.sqlite"),
    serversDir: join(dataDir, "servers"),
    backupsDir: join(dataDir, "backups"),
    importsDir: join(dataDir, "imports"),
    exportsDir: join(dataDir, "exports"),
    tmpDir,
    nodeUpdatesDir: join(tmpDir, "node-updates")
  };
}

export function initializeRuntimeDataRoot(paths: RuntimeDataPaths) {
  for (const directory of [paths.dataDir, paths.serversDir, paths.backupsDir, paths.importsDir, paths.exportsDir, paths.tmpDir]) {
    mkdirSync(directory, { recursive: true });
  }
}
