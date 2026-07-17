import { describe, expect, it, vi } from "vitest";
import type { ManagedServer, ServerEvent, ServerTimelineEvent } from "./types.js";
import { TimelineEventCollector } from "./timelineEventCollector.js";

function event(timestamp?: string): ServerEvent {
  return {
    id: "event-1",
    eventType: "player_joined",
    type: "success",
    severity: "success",
    text: "Alex joined",
    message: "Alex joined",
    timestamp,
    signature: "player_joined:alex",
    source: "logs/latest.log",
    subject: "Alex"
  };
}

describe("TimelineEventCollector", () => {
  it("persists timestamped events and lets repository identity deduplicate repeated tails", async () => {
    const stored = new Map<string, ServerTimelineEvent>();
    const timestamp = new Date().toISOString();
    const repository = {
      append: (_serverId: string, key: string, value: ServerTimelineEvent) => stored.set(key, value),
      prune: vi.fn()
    };
    const collector = new TimelineEventCollector({
      intervalMs: 10_000,
      retentionMs: 24 * 60 * 60 * 1000,
      readServers: async () => [{ id: "server-1" } as ManagedServer],
      readLogs: async () => ({ text: "line", source: "logs/latest.log" }),
      parseLine: () => event(timestamp),
      repository: repository as never
    });
    await collector.collectAll();
    await collector.collectAll();
    expect(stored.size).toBe(1);
    expect([...stored.values()][0].occurredAt).toBeTypeOf("number");
  });

  it("ignores events without a placeable timestamp and isolates read failures", async () => {
    const append = vi.fn();
    const onError = vi.fn();
    const collector = new TimelineEventCollector({
      intervalMs: 10_000,
      retentionMs: 24 * 60 * 60 * 1000,
      readServers: async () => [{ id: "server-1" }, { id: "server-2" }] as ManagedServer[],
      readLogs: async (server) => server.id === "server-1" ? { text: "line", source: "docker" } : Promise.reject(new Error("offline")),
      parseLine: () => event(),
      repository: { append, prune: vi.fn() } as never,
      onError
    });
    await collector.collectAll();
    expect(append).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });
});
