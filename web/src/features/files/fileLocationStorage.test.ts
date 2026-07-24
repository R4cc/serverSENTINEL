import { describe, expect, it, vi } from "vitest";
import { readStoredFileLocation, writeStoredFileLocation } from "./fileLocationStorage";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: vi.fn((key: string) => values.delete(key))
  } as unknown as Storage;
}

describe("file manager location storage", () => {
  it("stores locations separately for each server", () => {
    const target = storage();
    writeStoredFileLocation("server-a", "/config/plugins", target, 1_000);
    writeStoredFileLocation("server-b", "/world", target, 1_000);

    expect(readStoredFileLocation("server-a", target, 1_001)).toBe("/config/plugins");
    expect(readStoredFileLocation("server-b", target, 1_001)).toBe("/world");
  });

  it("falls back to root for unsafe or malformed stored paths", () => {
    const target = storage({
      "serversentinel-file-location:server-a": "../outside"
    });

    expect(readStoredFileLocation("server-a", target)).toBe("/");
  });

  it("expires a stored directory after thirty minutes", () => {
    const target = storage();
    writeStoredFileLocation("server-a", "/world", target, 1_000);

    expect(readStoredFileLocation("server-a", target, 1_000 + 30 * 60 * 1000 - 1)).toBe("/world");
    expect(readStoredFileLocation("server-a", target, 1_000 + 30 * 60 * 1000)).toBe("/");
  });

  it("treats legacy untimestamped locations as expired", () => {
    const target = storage({
      "serversentinel-file-location:server-a": "/world"
    });

    expect(readStoredFileLocation("server-a", target, 1_000)).toBe("/");
    expect(target.removeItem).toHaveBeenCalledWith("serversentinel-file-location:server-a");
  });
});
