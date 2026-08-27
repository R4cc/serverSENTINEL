import { describe, expect, it } from "vitest";
import type { NodeView } from "../../types";
import {
  muteNodeUpdateVisitNotification,
  nodeUpdateNotificationMuteMs,
  nodeUpdateNotificationMuteStorageKey,
  nodeUpdateVisitNotificationMuted,
  nodeUpdateVisitNotificationText
} from "./useNodeUpdateVisitNotification";

function node(name: string, overrides: Partial<NodeView> = {}): NodeView {
  return {
    id: name.toLowerCase().replaceAll(" ", "-"),
    name,
    type: "remote",
    status: "online",
    isInternal: false,
    agentVersion: "1.11.0",
    buildId: "old-build",
    ...overrides
  };
}

describe("node update visit notifications", () => {
  it("names one node and collapses multiple updates into one fleet message", () => {
    expect(nodeUpdateVisitNotificationText([node("Alpha")], "1.12.0", "new-build"))
      .toBe("Alpha has an update available.");
    expect(nodeUpdateVisitNotificationText([node("Alpha"), node("Beta")], "1.12.0", "new-build"))
      .toBe("Multiple nodes have an update available.");
  });

  it("excludes nodes whose update notifications are disabled", () => {
    expect(nodeUpdateVisitNotificationText([
      node("Muted", { updateNotificationsEnabled: false }),
      node("Current", { agentVersion: "1.12.0", buildId: "new-build" })
    ], "1.12.0", "new-build")).toBe("");
  });

  it("notifies for a changed build but not for newer, incomparable, internal, or current nodes", () => {
    expect(nodeUpdateVisitNotificationText([
      node("Rebuilt", { agentVersion: "1.12.0", buildId: "old-build" })
    ], "1.12.0", "new-build")).toBe("Rebuilt has an update available.");
    expect(nodeUpdateVisitNotificationText([
      node("Newer", { agentVersion: "1.13.0" }),
      node("Mismatch", { agentVersion: "development" }),
      node("Internal", { isInternal: true, type: "local" }),
      node("Current", { agentVersion: "1.12.0", buildId: "new-build" })
    ], "1.12.0", "new-build")).toBe("");
  });

  it("mutes notifications for exactly three days", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    };
    const now = Date.UTC(2026, 7, 13, 12);

    muteNodeUpdateVisitNotification(storage, now);

    expect(values.get(nodeUpdateNotificationMuteStorageKey)).toBe(String(now + nodeUpdateNotificationMuteMs));
    expect(nodeUpdateVisitNotificationMuted(storage, now + nodeUpdateNotificationMuteMs - 1)).toBe(true);
    expect(nodeUpdateVisitNotificationMuted(storage, now + nodeUpdateNotificationMuteMs)).toBe(false);
  });

  it("suppresses update notifications in demo mode", () => {
    expect(nodeUpdateVisitNotificationText(
      [node("Demo agent")],
      "1.12.0",
      "new-build",
      true
    )).toBe("");
  });
});
