import { describe, expect, it } from "vitest";
import { consoleReconnectDelay, consoleUnavailableIsRetryable, isNodeOfflineConsoleMessage } from "./consolePipeline";

describe("console pipeline", () => {
  it("recognizes structured and legacy offline messages", () => {
    expect(isNodeOfflineConsoleMessage({ code: "NODE_OFFLINE" })).toBe(true);
    expect(isNodeOfflineConsoleMessage({ message: "Node Remote is offline" })).toBe(true);
  });

  it("trusts an explicit retryable flag over the message text", () => {
    expect(consoleUnavailableIsRetryable({ message: "Node Remote is offline", retryable: false })).toBe(false);
    expect(consoleUnavailableIsRetryable({ message: "Docker logs returned 404" })).toBe(false);
    expect(consoleUnavailableIsRetryable({ message: "Command timed out" })).toBe(true);
  });

  it("uses bounded reconnect backoff", () => {
    expect([0, 1, 2, 3, 4, 8].map(consoleReconnectDelay)).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });
});
