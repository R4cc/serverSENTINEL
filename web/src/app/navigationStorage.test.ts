import { describe, expect, it, vi } from "vitest";
import { navigationStorageDurationMs, readStoredActivePage, writeStoredActivePage } from "./navigationStorage";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key))
  } as unknown as Storage;
}

describe("active page storage", () => {
  it("restores the active page during the navigation window", () => {
    const target = storage();
    writeStoredActivePage("properties", target, 1_000);

    expect(readStoredActivePage(target, 1_000 + navigationStorageDurationMs - 1)).toBe("properties");
  });

  it("falls back to overview when the active page expires", () => {
    const target = storage();
    writeStoredActivePage("properties", target, 1_000);

    expect(readStoredActivePage(target, 1_000 + navigationStorageDurationMs)).toBe("overview");
  });

  it("treats legacy and invalid active pages as expired", () => {
    const legacy = storage({ "serversentinel-active-page": "properties" });
    const invalid = storage({
      "serversentinel-active-page": JSON.stringify({ value: "missing", savedAt: 1_000 })
    });

    expect(readStoredActivePage(legacy, 1_001)).toBe("overview");
    expect(readStoredActivePage(invalid, 1_001)).toBe("overview");
  });
});
