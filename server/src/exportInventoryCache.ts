import { randomUUID } from "node:crypto";
import type { ExportSelection } from "@serversentinel/contracts";
import type { CollectedCategory } from "./servers/exportSelection.js";

export const exportInventoryTtlMs = 5 * 60 * 1000;
const exportInventoryMaxEntries = 4;

type CachedExportInventory = {
  createdBy: string;
  scope: string;
  mutationVersions: Map<string, number>;
  inventoryByServer: Map<string, CollectedCategory[]>;
  createdAt: number;
};

type StoreExportInventoryInput = {
  createdBy: string;
  serverIds: readonly string[];
  selection: ExportSelection;
  mutationVersion: (serverId: string) => number;
  inventoryByServer: Map<string, CollectedCategory[]>;
};

type TakeExportInventoryInput = {
  id: string;
  createdBy: string;
  serverIds: readonly string[];
  selection: ExportSelection;
  mutationVersion: (serverId: string) => number;
};

function inventoryScope(serverIds: readonly string[], selection: ExportSelection) {
  return JSON.stringify({
    serverIds: [...serverIds].sort(),
    categories: selection.categories,
    contentStrategy: selection.contentStrategy
  });
}

/**
 * Keeps only the expensive filesystem inventory behind an opaque, one-use token. The cache is
 * process-local by design: a restart or an evicted token simply makes export fall back to a fresh walk.
 */
export class ExportInventoryCache {
  private readonly entries = new Map<string, CachedExportInventory>();
  private readonly expiryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  store(input: StoreExportInventoryInput, now = Date.now()) {
    this.prune(now);
    while (this.entries.size >= exportInventoryMaxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (!oldest) break;
      this.delete(oldest);
    }
    const id = randomUUID();
    const mutationVersions = new Map(input.serverIds.map((serverId) => [serverId, input.mutationVersion(serverId)]));
    this.entries.set(id, {
      createdBy: input.createdBy,
      scope: inventoryScope(input.serverIds, input.selection),
      mutationVersions,
      inventoryByServer: input.inventoryByServer,
      createdAt: now
    });
    const expiry = setTimeout(() => this.delete(id), exportInventoryTtlMs);
    expiry.unref();
    this.expiryTimers.set(id, expiry);
    return id;
  }

  take(input: TakeExportInventoryInput, now = Date.now()) {
    this.prune(now);
    const cached = this.entries.get(input.id);
    if (!cached || cached.createdBy !== input.createdBy) return undefined;
    this.delete(input.id);
    if (cached.scope !== inventoryScope(input.serverIds, input.selection)) return undefined;
    if ([...cached.mutationVersions].some(([serverId, version]) => input.mutationVersion(serverId) !== version)) return undefined;
    return cached.inventoryByServer;
  }

  private prune(now: number) {
    for (const [id, cached] of this.entries) {
      if (now - cached.createdAt >= exportInventoryTtlMs) this.delete(id);
    }
  }

  private delete(id: string) {
    this.entries.delete(id);
    const expiry = this.expiryTimers.get(id);
    if (expiry) clearTimeout(expiry);
    this.expiryTimers.delete(id);
  }
}

export const exportInventoryCache = new ExportInventoryCache();
