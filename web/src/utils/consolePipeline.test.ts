import { describe, expect, it } from "vitest";
import { consoleOfflineContradictsNode, consoleReconnectDelay, consoleUnavailableIsRetryable, isNodeOfflineConsoleMessage } from "./consolePipeline";

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

  it("rechecks a console that reports the node offline while the node reads as usable", () => {
    const offlineOnUsableNode = { consoleConnectionState: "offline" as const, nodeRuntimeUsable: true, alreadyRechecked: false };

    expect(consoleOfflineContradictsNode(offlineOnUsableNode)).toBe(true);
    // The node agrees the node is gone, so the panel is right and there is nothing to settle.
    expect(consoleOfflineContradictsNode({ ...offlineOnUsableNode, nodeRuntimeUsable: false })).toBe(false);
    // One reconnect settles it. Repeating it every connectivity poll is a reconnect loop.
    expect(consoleOfflineContradictsNode({ ...offlineOnUsableNode, alreadyRechecked: true })).toBe(false);
    expect(consoleOfflineContradictsNode({ ...offlineOnUsableNode, consoleConnectionState: "reconnecting" })).toBe(false);
  });

  it("uses bounded reconnect backoff", () => {
    expect([0, 1, 2, 3, 4, 8].map(consoleReconnectDelay)).toEqual([1000, 2000, 4000, 8000, 10000, 10000]);
  });
});
