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
  it.each(["stop", "delete"])("discards pending log observations after %s", async (action) => {
    let release!: (value: unknown) => void;
    const pending = new Promise((resolve) => { release = resolve; });
    const appendMany = vi.fn();
    const prune = vi.fn();
    const observer = vi.fn();
    let active = true;
    const collector = new TimelineEventCollector({
      intervalMs: 10_000, retentionMs: 60_000, readServers: async () => [{ id: "a" } as ManagedServer],
      isServerActive: () => active, readLogs: () => pending,
      parseLine: () => event(new Date().toISOString()), repository: { appendMany, prune } as never
    });
    collector.observeLogs(observer);
    const collection = collector.collectServer({ id: "a" } as ManagedServer);
    if (action === "stop") collector.stop();
    else active = false;
    release({ text: "Alex joined", source: "logs/latest.log" });
    await collection;
    expect(appendMany).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
    expect(prune).not.toHaveBeenCalled();
  });

  it("does not persist events when stopped during an asynchronous log observer", async () => {
    const appendMany = vi.fn();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const collector = new TimelineEventCollector({
      intervalMs: 10_000, retentionMs: 60_000, readServers: async () => [],
      readLogs: async () => ({ text: "Alex joined" }), parseLine: () => event(new Date().toISOString()),
      repository: { appendMany } as never
    });
    collector.observeLogs(() => { entered(); return blocked; });
    const collection = collector.collectServer({ id: "a" } as ManagedServer);
    await started;
    collector.stop();
    release();
    await collection;
    expect(appendMany).not.toHaveBeenCalled();
  });
  it("persists timestamped events and lets repository identity deduplicate repeated tails", async () => {
    const stored = new Map<string, ServerTimelineEvent>();
    const timestamp = new Date().toISOString();
    const repository = {
      appendMany: (_serverId: string, events: Array<{ eventKey: string; event: ServerTimelineEvent }>) => {
        for (const { eventKey, event: value } of events) stored.set(eventKey, value);
      },
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

  it("keeps repeated same-second events distinct while deduplicating the next poll", async () => {
    const stored = new Map<string, ServerTimelineEvent>();
    const timestamp = new Date().toISOString();
    const lines = ["Alex joined", "Alex left", "Alex joined"];
    const collector = new TimelineEventCollector({
      intervalMs: 10_000,
      retentionMs: 24 * 60 * 60 * 1000,
      readServers: async () => [{ id: "server-1" } as ManagedServer],
      readLogs: async () => ({ text: lines.join("\n"), source: "logs/latest.log" }),
      parseLine: (line, source, index) => ({
        ...event(timestamp),
        id: `${source}-${String(index).padStart(8, "0")}`,
        eventType: line.endsWith("left") ? "player_left" : "player_joined",
        signature: line.endsWith("left") ? "player_left:alex" : "player_joined:alex",
        message: line,
        text: line
      }),
      repository: {
        appendMany: (_serverId: string, events: Array<{ eventKey: string; event: ServerTimelineEvent }>) => {
          for (const item of events) stored.set(item.eventKey, item.event);
        },
        prune: vi.fn()
      } as never
    });

    await collector.collectAll();
    await collector.collectAll();

    expect(stored.size).toBe(3);
    expect([...stored.values()].map((value) => value.eventType)).toEqual(["player_joined", "player_left", "player_joined"]);
  });

  it("ignores events without a placeable timestamp and isolates read failures", async () => {
    const appendMany = vi.fn();
    const onError = vi.fn();
    const collector = new TimelineEventCollector({
      intervalMs: 10_000,
      retentionMs: 24 * 60 * 60 * 1000,
      readServers: async () => [{ id: "server-1" }, { id: "server-2" }] as ManagedServer[],
      readLogs: async (server) => server.id === "server-1" ? { text: "line", source: "docker" } : Promise.reject(new Error("offline")),
      parseLine: () => event(),
      repository: { appendMany, prune: vi.fn() } as never,
      onError
    });
    await collector.collectAll();
    expect(appendMany).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledOnce();
  });

  it("rejects events whose timestamps are implausibly far in the future", async () => {
    const appendMany = vi.fn();
    const collector = new TimelineEventCollector({
      intervalMs: 10_000,
      retentionMs: 24 * 60 * 60 * 1000,
      readServers: async () => [{ id: "server-1" }] as ManagedServer[],
      readLogs: async () => ({ text: "line", source: "docker" }),
      parseLine: () => event(new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()),
      repository: { appendMany, prune: vi.fn() } as never
    });

    await collector.collectAll();
    expect(appendMany).not.toHaveBeenCalled();
  });
});
