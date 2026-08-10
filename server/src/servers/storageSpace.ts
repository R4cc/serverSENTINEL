import { statfs } from "node:fs/promises";
import type { ManagedServer } from "../types.js";

export function storageSpaceFromStats(stats: { blocks: number; bavail: number; bsize: number }) {
  return {
    totalBytes: Math.max(0, stats.blocks * stats.bsize),
    availableBytes: Math.max(0, stats.bavail * stats.bsize)
  };
}

export async function storageSpaceForPath(path: string) {
  return storageSpaceFromStats(await statfs(path));
}

export function localServerStorage(server: ManagedServer) {
  return storageSpaceForPath(server.serverDir);
}
