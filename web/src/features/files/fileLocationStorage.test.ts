import { describe, expect, it, vi } from "vitest";
import { readStoredFileLocation, writeStoredFileLocation } from "./fileLocationStorage";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value))
  } as unknown as Storage;
}

describe("file manager location storage", () => {
  it("stores locations separately for each server", () => {
    const target = storage();
    writeStoredFileLocation("server-a", "/config/plugins", target);
    writeStoredFileLocation("server-b", "/world", target);

    expect(readStoredFileLocation("server-a", target)).toBe("/config/plugins");
    expect(readStoredFileLocation("server-b", target)).toBe("/world");
  });

  it("falls back to root for unsafe or malformed stored paths", () => {
    const target = storage({
      "serversentinel-file-location:server-a": "../outside"
    });

    expect(readStoredFileLocation("server-a", target)).toBe("/");
  });
});
