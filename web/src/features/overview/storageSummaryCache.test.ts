import { describe, expect, it, vi } from "vitest";
import {
  clearCachedStorageSummary,
  readCachedStorageSummary,
  storageSummaryCacheDurationMs,
  writeCachedStorageSummary
} from "./storageSummaryCache";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key))
  } as unknown as Storage;
}

const summary = { worldSizeBytes: 7_566, totalBytes: 100_000, availableBytes: 8_000 };

describe("server storage summary cache", () => {
  it("returns the last measured sizes so a reload can render them before the live read", () => {
    const target = storage();
    writeCachedStorageSummary("server-a", summary, target, 1_000);

    expect(readCachedStorageSummary("server-a", target, 2_000)).toEqual(summary);
  });

  it("keeps a summary per server", () => {
    const target = storage();
    writeCachedStorageSummary("server-a", summary, target, 1_000);
    writeCachedStorageSummary("server-b", { ...summary, worldSizeBytes: 42 }, target, 1_000);

    expect(readCachedStorageSummary("server-a", target, 1_001)?.worldSizeBytes).toBe(7_566);
    expect(readCachedStorageSummary("server-b", target, 1_001)?.worldSizeBytes).toBe(42);
  });

  it("expires a summary after a day rather than presenting an old measurement", () => {
    const target = storage();
    writeCachedStorageSummary("server-a", summary, target, 1_000);

    expect(readCachedStorageSummary("server-a", target, 1_000 + storageSummaryCacheDurationMs - 1)).toEqual(summary);
    expect(readCachedStorageSummary("server-a", target, 1_000 + storageSummaryCacheDurationMs)).toBeNull();
  });

  it("drops byte counts that are not usable measurements", () => {
    const target = storage();
    writeCachedStorageSummary(
      "server-a",
      { worldSizeBytes: 7_566, totalBytes: Number.NaN, availableBytes: -1 } as never,
      target,
      1_000
    );

    expect(readCachedStorageSummary("server-a", target, 1_001)).toEqual({
      worldSizeBytes: 7_566,
      totalBytes: null,
      availableBytes: null
    });
  });

  it("reports nothing when every stored byte count is unusable", () => {
    const target = storage();
    writeCachedStorageSummary("server-a", { worldSizeBytes: null, totalBytes: null, availableBytes: null }, target, 1_000);

    expect(readCachedStorageSummary("server-a", target, 1_001)).toBeNull();
  });

  it("discards a malformed entry instead of failing the render", () => {
    const target = storage({ "serversentinel-storage-summary:server-a": JSON.stringify({ value: "{oops", savedAt: 1_000 }) });

    expect(readCachedStorageSummary("server-a", target, 1_001)).toBeNull();
    expect(target.removeItem).toHaveBeenCalledWith("serversentinel-storage-summary:server-a");
  });

  it("clears a summary so a failed measurement stops standing in for a live one", () => {
    const target = storage();
    writeCachedStorageSummary("server-a", summary, target, 1_000);
    clearCachedStorageSummary("server-a", target);

    expect(readCachedStorageSummary("server-a", target, 1_001)).toBeNull();
  });
});
