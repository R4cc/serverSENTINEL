import { describe, expect, it } from "vitest";
import { ExportInventoryCache, exportInventoryTtlMs } from "./exportInventoryCache.js";
import type { ExportSelection } from "@serversentinel/contracts";
import type { CollectedCategory } from "./servers/exportSelection.js";

const selection: ExportSelection = { categories: ["world"], contentStrategy: "lockfile" };
const inventory = new Map<string, CollectedCategory[]>([["server-1", [{ category: "world", files: [], totalBytes: 0 }]]]);

describe("export inventory cache", () => {
  it("returns a matching inventory only once", () => {
    const cache = new ExportInventoryCache();
    const mutationVersion = () => 0;
    const id = cache.store({ createdBy: "user-1", serverIds: ["server-1"], selection, mutationVersion, inventoryByServer: inventory }, 1_000);

    expect(cache.take({ id, createdBy: "user-1", serverIds: ["server-1"], selection, mutationVersion }, 1_001)).toBe(inventory);
    expect(cache.take({ id, createdBy: "user-1", serverIds: ["server-1"], selection, mutationVersion }, 1_002)).toBeUndefined();
  });

  it("does not let another user consume the token", () => {
    const cache = new ExportInventoryCache();
    const mutationVersion = () => 0;
    const id = cache.store({ createdBy: "user-1", serverIds: ["server-1"], selection, mutationVersion, inventoryByServer: inventory }, 1_000);

    expect(cache.take({ id, createdBy: "user-2", serverIds: ["server-1"], selection, mutationVersion }, 1_001)).toBeUndefined();
    expect(cache.take({ id, createdBy: "user-1", serverIds: ["server-1"], selection, mutationVersion }, 1_002)).toBe(inventory);
  });

  it("rejects an inventory after a server mutation or expiry", () => {
    const cache = new ExportInventoryCache();
    let version = 4;
    const mutationVersion = () => version;
    const staleId = cache.store({ createdBy: "user-1", serverIds: ["server-1"], selection, mutationVersion, inventoryByServer: inventory }, 1_000);
    version += 1;
    expect(cache.take({ id: staleId, createdBy: "user-1", serverIds: ["server-1"], selection, mutationVersion }, 1_001)).toBeUndefined();

    const expiredId = cache.store({ createdBy: "user-1", serverIds: ["server-1"], selection, mutationVersion, inventoryByServer: inventory }, 2_000);
    expect(cache.take({ id: expiredId, createdBy: "user-1", serverIds: ["server-1"], selection, mutationVersion }, 2_000 + exportInventoryTtlMs)).toBeUndefined();
  });
});
