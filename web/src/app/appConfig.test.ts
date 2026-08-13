import { describe, expect, it } from "vitest";
import { readStoredSignedIn, shouldLoadPlayerSnapshots, shouldShowApplicationLoadingSkeleton, shouldShowInitialOverviewLoading, writeStoredSignedIn } from "./appConfig";

function memoryStorage(seed: Record<string, string> = {}) {
  const entries = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() { return entries.size; }
  } satisfies Storage;
}

describe("application loading layout", () => {
  it("keeps the static settings structure in place instead of stacking a page skeleton above it", () => {
    expect(shouldShowApplicationLoadingSkeleton("settings")).toBe(false);
    expect(shouldShowApplicationLoadingSkeleton("overview")).toBe(true);
  });

  it("only replaces overview values during the initial empty load", () => {
    expect(shouldShowInitialOverviewLoading(true, 0, 0)).toBe(true);
    expect(shouldShowInitialOverviewLoading(true, 2, 0)).toBe(false);
    expect(shouldShowInitialOverviewLoading(true, 0, 3)).toBe(false);
    expect(shouldShowInitialOverviewLoading(false, 0, 0)).toBe(false);
  });
});

describe("player snapshot loading", () => {
  it("loads for Nodes and every page whose server status bar can show the count", () => {
    expect(shouldLoadPlayerSnapshots("nodes")).toBe(true);
    expect(shouldLoadPlayerSnapshots("overview")).toBe(true);
    expect(shouldLoadPlayerSnapshots("console")).toBe(true);
    expect(shouldLoadPlayerSnapshots("files")).toBe(true);
    expect(shouldLoadPlayerSnapshots("mods")).toBe(true);
    expect(shouldLoadPlayerSnapshots("schedule")).toBe(true);
    expect(shouldLoadPlayerSnapshots("properties")).toBe(true);
  });

  it("does not poll pages that have no player-count consumer", () => {
    expect(shouldLoadPlayerSnapshots("create")).toBe(false);
    expect(shouldLoadPlayerSnapshots("settings")).toBe(false);
  });
});

describe("signed-in boot hint", () => {
  it("round-trips the hint so the next first paint reserves the workspace shell", () => {
    const storage = memoryStorage();
    expect(readStoredSignedIn(storage)).toBe(false);
    writeStoredSignedIn(true, storage);
    expect(readStoredSignedIn(storage)).toBe(true);
  });

  it("clears the hint on sign-out so the sign-in skeleton comes back", () => {
    const storage = memoryStorage({ "serversentinel-signed-in": "true" });
    writeStoredSignedIn(false, storage);
    expect(readStoredSignedIn(storage)).toBe(false);
    expect(storage.getItem("serversentinel-signed-in")).toBeNull();
  });

  it("treats unavailable storage as signed out rather than throwing during boot", () => {
    const unavailable = {
      getItem: () => { throw new Error("storage disabled"); },
      setItem: () => { throw new Error("storage disabled"); },
      removeItem: () => { throw new Error("storage disabled"); },
      clear: () => {},
      key: () => null,
      length: 0
    } satisfies Storage;
    expect(readStoredSignedIn(unavailable)).toBe(false);
    expect(() => writeStoredSignedIn(true, unavailable)).not.toThrow();
  });
});
