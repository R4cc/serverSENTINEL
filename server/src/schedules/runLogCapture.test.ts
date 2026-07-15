import { describe, expect, it } from "vitest";
import { captureScheduledCommandLogs } from "./runLogCapture.js";

describe("scheduled command log capture", () => {
  it("keeps only entries appended after the command boundary", () => {
    expect(captureScheduledCommandLogs("one\ntwo\n", "one\ntwo\nthree\nfour\n")).toEqual({
      logCaptureStatus: "captured",
      logs: ["three", "four"]
    });
  });

  it("handles a shifted recent-log window", () => {
    expect(captureScheduledCommandLogs("one\ntwo\nthree\n", "two\nthree\nfour\n")).toEqual({
      logCaptureStatus: "captured",
      logs: ["four"]
    });
  });

  it("reports empty and unreliable captures explicitly", () => {
    expect(captureScheduledCommandLogs("same\n", "same\n")).toEqual({ logCaptureStatus: "empty", logs: [] });
    expect(captureScheduledCommandLogs(undefined, "new\n")).toEqual({ logCaptureStatus: "unavailable" });
    expect(captureScheduledCommandLogs("old\n", "unrelated\n")).toEqual({ logCaptureStatus: "unavailable" });
  });

  it("bounds persisted output to the most recent 60 entries", () => {
    const appended = Array.from({ length: 70 }, (_, index) => `line-${index}`).join("\n");
    const result = captureScheduledCommandLogs("baseline\n", `baseline\n${appended}\n`);

    expect(result.logs).toHaveLength(60);
    expect(result.logs?.[0]).toBe("line-10");
    expect(result.logs?.at(-1)).toBe("line-69");
  });
});
