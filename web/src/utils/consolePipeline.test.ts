import { describe, expect, it } from "vitest";
import { appendConsoleEntries, ConsoleLineAssembler, consoleReconnectDelay, ConsoleReplayGuard, consoleSnapshotLines, isNodeOfflineConsoleMessage, reconcileConsoleSnapshot } from "./consolePipeline";

describe("console pipeline", () => {
  it("splits stream chunks into the same line entries a snapshot produces", () => {
    const assembler = new ConsoleLineAssembler();

    expect(assembler.push("[12:00:01] one\n[12:00:02] tw")).toEqual(["[12:00:01] one\n"]);
    expect(assembler.push("o\r\n[12:00:03] three\n")).toEqual(["[12:00:02] two\n", "[12:00:03] three\n"]);
    expect(assembler.push("no newline yet")).toEqual([]);
  });

  it("reconciles a snapshot against lines the stream already delivered as chunks", () => {
    // The websocket delivered two lines in a single frame; the snapshot repeats them and adds a
    // third. Without matching units the whole buffer would be replaced and the terminal redrawn.
    const assembler = new ConsoleLineAssembler();
    const streamed = assembler.push("one\ntwo\n");
    const snapshot = consoleSnapshotLines("one\ntwo\nthree\n").map((line) => `${line}\n`);

    expect(reconcileConsoleSnapshot(streamed, snapshot, streamed))
      .toEqual(["one\n", "two\n", "three\n"]);
  });

  it("reconciles overlapping snapshots and preserves live lines received during loading", () => {
    expect(reconcileConsoleSnapshot(["a", "b"], ["b", "c"], ["a", "b", "d"])).toEqual(["a", "b", "c", "d"]);
  });

  it("keeps live lines that arrived after the scrollback limit trimmed the buffer head", () => {
    // The snapshot request started at ["a", "b", "c"]; three more lines streamed in while it was
    // in flight and a limit of three dropped the head, so the tail is no longer a suffix of a
    // buffer that still starts with "a".
    expect(reconcileConsoleSnapshot(["a", "b", "c"], ["b", "c", "d"], ["d", "e", "f"], 5))
      .toEqual(["b", "c", "d", "e", "f"]);
  });

  it("replaces obsolete history after log rotation", () => {
    expect(reconcileConsoleSnapshot(["old-a", "old-b"], ["new-a", "new-b"], ["old-a", "old-b"])).toEqual(["new-a", "new-b"]);
  });

  it("deduplicates appended entries and enforces the history limit", () => {
    expect(appendConsoleEntries(["a", "b"], ["b", "c"], 3)).toEqual(["a", "b", "c"]);
    expect(appendConsoleEntries(["a", "b", "c"], ["d"], 3)).toEqual(["b", "c", "d"]);
  });

  it("filters a historical websocket replay split before the live tail", () => {
    const guard = new ConsoleReplayGuard([
      "[08:15] starting",
      "[08:15] Alex joined",
      "[08:45] saved",
      "[09:42] list"
    ]);

    expect(guard.push(["[08:15] starting", "[08:15] Alex joined"])).toEqual([]);
    expect(guard.push(["[08:45] saved"])).toEqual([]);
    expect(guard.push(["[09:42] list", "[09:43] Steve joined"])).toEqual(["[09:43] Steve joined"]);
    expect(guard.push(["[09:43] Steve joined"])).toEqual(["[09:43] Steve joined"]);
  });

  it("filters a replay that begins at a trailing subset of the snapshot", () => {
    const guard = new ConsoleReplayGuard(["old", "tail-a", "tail-b"]);

    expect(guard.push(["tail-a"])).toEqual([]);
    expect(guard.push(["tail-b", "live"])).toEqual(["live"]);
  });

  it("keeps replay candidates across frames when the first line appears more than once", () => {
    const guard = new ConsoleReplayGuard(["repeat", "startup", "repeat", "later"]);

    expect(guard.push(["repeat"])).toEqual([]);
    expect(guard.push(["startup"])).toEqual([]);
    expect(guard.push(["repeat", "later", "live"])).toEqual(["live"]);
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
