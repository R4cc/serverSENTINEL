import { describe, expect, it } from "vitest";
import { appendConsoleEntries, consoleReconnectDelay, consoleSnapshotLines, isNodeOfflineConsoleMessage, reconcileConsoleSnapshot } from "./consolePipeline";

describe("console pipeline", () => {
  it("reconciles overlapping snapshots and preserves live lines received during loading", () => {
    expect(reconcileConsoleSnapshot(["a", "b"], ["b", "c"], ["a", "b", "d"])).toEqual(["a", "b", "c", "d"]);
  });

  it("replaces obsolete history after log rotation", () => {
    expect(reconcileConsoleSnapshot(["old-a", "old-b"], ["new-a", "new-b"], ["old-a", "old-b"])).toEqual(["new-a", "new-b"]);
  });

  it("deduplicates appended entries and enforces the history limit", () => {
    expect(appendConsoleEntries(["a", "b"], ["b", "c"], 3)).toEqual(["a", "b", "c"]);
    expect(appendConsoleEntries(["a", "b", "c"], ["d"], 3)).toEqual(["b", "c", "d"]);
  });

  it("keeps the configured number of snapshot lines instead of truncating to 200", () => {
    const snapshot = Array.from({ length: 1_200 }, (_, index) => `line-${index}`).join("\n");

    expect(consoleSnapshotLines(snapshot, 5_000)).toHaveLength(1_200);
    expect(consoleSnapshotLines(snapshot, 1_000)).toEqual(
      Array.from({ length: 1_000 }, (_, index) => `line-${index + 200}`)
    );
  });

  it("recognizes structured and legacy offline messages", () => {
    expect(isNodeOfflineConsoleMessage({ code: "NODE_OFFLINE" })).toBe(true);
    expect(isNodeOfflineConsoleMessage({ message: "Node Remote is offline" })).toBe(true);
  });

  it("uses bounded reconnect backoff", () => {
    expect([0, 1, 2, 3, 4, 8].map(consoleReconnectDelay)).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });
});
