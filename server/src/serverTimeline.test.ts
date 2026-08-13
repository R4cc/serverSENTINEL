import { describe, expect, it } from "vitest";
import type { ResourceStatsSample } from "./resourceStatsCollector.js";
import type { ServerTimelineEvent } from "./types.js";
import { timelinePlayerActivity, timelinePlayerIsKnown, timelineResourcePoints, timelineScheduleMarkers } from "./serverTimeline.js";

function sample(sampledAt: number, rx: number, tx: number, overrides: Partial<ResourceStatsSample> = {}): ResourceStatsSample {
  return {
    available: true,
    running: true,
    cpuPercent: 20,
    cpuCapacityCores: 4,
    memoryUsageBytes: 1024,
    memoryLimitBytes: 4096,
    playersOnline: 2,
    networkRxBytes: rx,
    networkTxBytes: tx,
    readAt: new Date(sampledAt).toISOString(),
    sampledAt,
    ...overrides
  };
}

describe("server timeline resource points", () => {
  it("derives separate receive and transmit rates", () => {
    const points = timelineResourcePoints([sample(0, 100, 200), sample(5_000, 600, 1_200)], 5_000, 5_000, 100);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ cpuUtilizationPercent: 5, memoryUtilizationPercent: 25, playersOnline: 2, networkRxBytesPerSecond: 100, networkTxBytesPerSecond: 200 });
  });

  it("leaves gaps for counter resets, unavailable samples, and long pauses", () => {
    const points = timelineResourcePoints([
      sample(0, 1_000, 1_000),
      sample(5_000, 100, 100),
      sample(40_000, 500, 500),
      sample(45_000, 600, 600, { available: false, running: false })
    ], 0, 45_000, 100);
    expect(points[1].networkRxBytesPerSecond).toBeNull();
    expect(points.some((point) => point.sampledAt === 10_000 && point.cpuPercent === null)).toBe(true);
    expect(points.at(-1)?.cpuPercent).toBeNull();
  });

  it("does not emit a synthetic gap at the same timestamp as the first visible sample", () => {
    const points = timelineResourcePoints([
      sample(0, 100, 100),
      sample(40_000, 500, 500)
    ], 40_000, 40_000, 100);

    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ sampledAt: 40_000, available: true, running: true });
  });

  it("keeps resource series continuous through ordinary remote-collector jitter", () => {
    const points = timelineResourcePoints([
      sample(0, 100, 100),
      sample(20_000, 500, 700)
    ], 0, 20_000, 100);
    expect(points).toHaveLength(2);
    expect(points[1]).toMatchObject({
      cpuUtilizationPercent: 5,
      memoryUtilizationPercent: 25,
      networkRxBytesPerSecond: 20,
      networkTxBytesPerSecond: 30
    });
  });

  it("carries the last verified player count across running samples", () => {
    const points = timelineResourcePoints([
      sample(0, 100, 100, { playersOnline: 1 }),
      sample(5_000, 200, 200, { playersOnline: undefined }),
      sample(10_000, 300, 300, { playersOnline: undefined }),
      sample(15_000, 400, 400, { playersOnline: 2 }),
      sample(20_000, 500, 500, { playersOnline: undefined })
    ], 0, 20_000, 100);
    expect(points.map((point) => point.playersOnline)).toEqual([1, 1, 1, 2, 2]);
  });

  it("does not carry a cached player count across downtime or a long collection gap", () => {
    const points = timelineResourcePoints([
      sample(0, 100, 100, { playersOnline: 1 }),
      sample(5_000, 200, 200, { available: false, running: false, playersOnline: undefined }),
      sample(10_000, 300, 300, { playersOnline: undefined }),
      sample(15_000, 400, 400, { playersOnline: 2 }),
      sample(50_000, 500, 500, { playersOnline: undefined })
    ], 0, 50_000, 100);
    expect(points.find((point) => point.sampledAt === 10_000)?.playersOnline).toBeNull();
    expect(points.find((point) => point.sampledAt === 50_000)?.playersOnline).toBeNull();
  });

  it("caps dense histories through aggregation", () => {
    const samples = Array.from({ length: 1_500 }, (_, index) => sample(index * 5_000, index * 100, index * 200));
    expect(timelineResourcePoints(samples, 0, samples.at(-1)!.sampledAt, 300).length).toBeLessThanOrEqual(300);
  });

  it("leaves legacy CPU samples unnormalized and retains the final player count in an aggregate bucket", () => {
    const points = timelineResourcePoints([
      sample(0, 0, 0, { cpuCapacityCores: undefined, playersOnline: 1 }),
      sample(5_000, 10, 10, { cpuCapacityCores: undefined, playersOnline: 3 })
    ], 0, 5_000, 1);
    expect(points[0]).toMatchObject({ cpuUtilizationPercent: null, playersOnline: 3 });
  });

  it("normalizes retained legacy CPU samples with the latest known server capacity", () => {
    const points = timelineResourcePoints([
      sample(0, 0, 0, { cpuPercent: 160, cpuCapacityCores: undefined }),
      sample(5_000, 10, 10, { cpuPercent: 80, cpuCapacityCores: undefined })
    ], 0, 5_000, 100, 8);
    expect(points.map((point) => point.cpuUtilizationPercent)).toEqual([20, 10]);
  });

  it("holds the network rate across a repeated stats read and measures the next one from that read", () => {
    // A remote node serves stats from a cached observation, so the collector can file the same
    // read twice. Both counter deltas belong to the interval between the two distinct reads.
    const points = timelineResourcePoints([
      sample(0, 0, 0, { readAt: new Date(0).toISOString() }),
      sample(5_000, 5_000, 10_000, { readAt: new Date(5_000).toISOString() }),
      sample(10_000, 5_000, 10_000, { readAt: new Date(5_000).toISOString() }),
      sample(15_000, 15_000, 30_000, { readAt: new Date(15_000).toISOString() })
    ], 0, 15_000, 100);
    expect(points.map((point) => point.networkRxBytesPerSecond)).toEqual([null, 1_000, 1_000, 1_000]);
    expect(points.map((point) => point.networkTxBytesPerSecond)).toEqual([null, 2_000, 2_000, 2_000]);
  });

  it("stops holding a network rate once the reading it came from is older than the gap threshold", () => {
    const stalled = new Date(5_000).toISOString();
    const points = timelineResourcePoints([
      sample(0, 0, 0, { readAt: new Date(0).toISOString() }),
      sample(5_000, 5_000, 5_000, { readAt: stalled }),
      sample(10_000, 5_000, 5_000, { readAt: stalled }),
      sample(40_000, 5_000, 5_000, { readAt: stalled })
    ], 0, 40_000, 100);
    expect(points.map((point) => point.networkRxBytesPerSecond)).toEqual([null, 1_000, 1_000, null]);
    expect(points.at(-1)?.cpuUtilizationPercent).toBe(5);
  });

  it("preserves network reset gaps while aggregating", () => {
    const points = timelineResourcePoints([
      sample(0, 100, 100),
      sample(5_000, 200, 200),
      sample(10_000, 50, 50),
      sample(15_000, 150, 150)
    ], 0, 15_000, 2);
    expect(points).toHaveLength(2);
    expect(points[1].networkRxBytesPerSecond).toBeNull();
    expect(points[1].networkTxBytesPerSecond).toBeNull();
  });
});

describe("server timeline schedule markers", () => {
  const schedule = { id: "schedule-1", name: "Maintenance" };

  it("combines completed and active runs", () => {
    const from = new Date("2026-01-01T00:00:00.000Z").getTime();
    const result = timelineScheduleMarkers({
      runs: [{ id: "run-1", scheduleId: schedule.id, scheduleName: schedule.name, status: "failed", ranAt: "2026-01-01T00:01:00.000Z" }],
      activeRuns: [{ id: "active-1", scheduleId: schedule.id, scheduleName: schedule.name, status: "running", startedAt: "2026-01-01T00:02:00.000Z", stepCount: 1, cancellable: true }],
      from,
      to: from + 5 * 60_000,
      now: from + 2 * 60_000
    });
    expect(result.markers.map((marker) => marker.kind)).toEqual(["run", "active"]);
    expect(result.markers.find((marker) => marker.kind === "run")?.status).toBe("failed");
  });

  it("does not project runs that have not happened yet", () => {
    const from = new Date("2026-01-01T00:00:00.000Z").getTime();
    const result = timelineScheduleMarkers({
      runs: [{ id: "run-1", scheduleId: schedule.id, scheduleName: schedule.name, status: "success", ranAt: "2026-01-01T00:01:00.000Z" }],
      activeRuns: [],
      from,
      to: from + 60 * 60_000,
      now: from + 2 * 60_000
    });
    expect(result.markers.map((marker) => marker.id)).toEqual(["run:run-1"]);
  });

  it("keeps an active run visible after its start falls outside the window", () => {
    const from = new Date("2026-01-01T04:00:00.000Z").getTime();
    const result = timelineScheduleMarkers({
      runs: [],
      activeRuns: [{ id: "active-long", scheduleId: schedule.id, scheduleName: schedule.name, status: "running", startedAt: "2026-01-01T00:00:00.000Z", stepCount: 1, cancellable: true }],
      from,
      to: from + 60 * 60_000,
      now: from + 30 * 60_000
    });

    expect(result.markers).toMatchObject([{
      id: "active:active-long",
      occurredAt: new Date("2026-01-01T00:00:00.000Z").getTime(),
      kind: "active",
      status: "running"
    }]);
  });

  it("reports truncation once the run count passes the marker limit", () => {
    const from = new Date("2026-01-01T00:00:00.000Z").getTime();
    const result = timelineScheduleMarkers({
      runs: Array.from({ length: 8 }, (_, index) => ({
        id: `run-${index}`,
        scheduleId: schedule.id,
        scheduleName: schedule.name,
        status: "success",
        ranAt: new Date(from + index * 60_000).toISOString()
      })),
      activeRuns: [],
      from,
      to: from + 60 * 60_000,
      now: from + 60 * 60_000,
      limit: 3
    });
    expect(result.markers).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });
});

function playerEvent(id: string, eventType: "player_joined" | "player_left", subject: string, occurredAt: number): ServerTimelineEvent {
  return {
    id,
    eventType,
    type: eventType === "player_joined" ? "success" : "info",
    severity: eventType === "player_joined" ? "success" : "info",
    text: `${subject} ${eventType === "player_joined" ? "joined" : "left"}`,
    message: `${subject} ${eventType === "player_joined" ? "joined" : "left"}`,
    signature: `${eventType}:${subject.toLowerCase()}`,
    source: "logs/latest.log",
    subject,
    occurredAt
  };
}

describe("server timeline player activity", () => {
  it("recognizes player names from retained join and leave events", () => {
    const events = [
      playerEvent("join", "player_joined", "Alex", 10),
      playerEvent("leave", "player_left", "Robin", 20)
    ];

    expect(timelinePlayerIsKnown(events, " alex ")).toBe(true);
    expect(timelinePlayerIsKnown(events, "ROBIN")).toBe(true);
    expect(timelinePlayerIsKnown(events, "Steve")).toBe(false);
  });

  it("pairs sessions, ignores duplicate state changes, and keeps reconnects separate", () => {
    const result = timelinePlayerActivity({
      contextFrom: 0,
      from: 0,
      to: 100,
      now: 100,
      events: [
        playerEvent("join-1", "player_joined", "Alex", 10),
        playerEvent("join-duplicate", "player_joined", "alex", 11),
        playerEvent("leave-1", "player_left", "ALEX", 30),
        playerEvent("leave-duplicate", "player_left", "Alex", 31),
        playerEvent("join-2", "player_joined", "Alex", 40)
      ],
      snapshot: { state: "live", online: 1, maxPlayers: 20, names: ["Alex"], sampledAt: new Date(100).toISOString() }
    });

    expect(result.onlineNames).toEqual(["Alex"]);
    expect(result.sessions).toMatchObject([
      { player: "Alex", startedAt: 10, endedAt: 30, startBoundary: "join", endBoundary: "leave" },
      { player: "Alex", startedAt: 40, endedAt: null, startBoundary: "join", endBoundary: "online" }
    ]);
  });

  it("closes open sessions at lifecycle events", () => {
    const stopped: ServerTimelineEvent = {
      id: "stopped",
      eventType: "server_stopped",
      type: "info",
      severity: "info",
      text: "Server stopped",
      message: "Server stopped",
      signature: "server_stopped",
      source: "docker",
      occurredAt: 50
    };
    const result = timelinePlayerActivity({
      contextFrom: 0,
      from: 0,
      to: 100,
      now: 100,
      events: [playerEvent("join", "player_joined", "Alex", 10), stopped],
      snapshot: { state: "stopped", online: 0, maxPlayers: 20, names: [], sampledAt: new Date(100).toISOString() }
    });
    expect(result.sessions).toMatchObject([{ startedAt: 10, endedAt: 50, endBoundary: "server-end" }]);
  });

  it("bounds sessions with an unknown start by the last server start", () => {
    const started: ServerTimelineEvent = {
      id: "started",
      eventType: "server_started",
      type: "success",
      severity: "success",
      text: "Server started",
      message: "Server started",
      signature: "server_started",
      source: "docker",
      occurredAt: 30
    };
    const result = timelinePlayerActivity({
      contextFrom: 0,
      from: 0,
      to: 100,
      now: 100,
      events: [playerEvent("join", "player_joined", "Alex", 10), started, playerEvent("leave", "player_left", "Robin", 60)],
      snapshot: { state: "live", online: 0, maxPlayers: 20, names: [], sampledAt: new Date(100).toISOString() }
    });
    expect(result.sessions).toMatchObject([
      { player: "Alex", startedAt: 10, endedAt: 30, startBoundary: "join", endBoundary: "server-end" },
      { player: "Robin", startedAt: 30, endedAt: 60, startBoundary: "history-boundary", endBoundary: "leave" }
    ]);
  });

  it("keeps last-confirmed players visible while their snapshot is temporarily stale", () => {
    const result = timelinePlayerActivity({
      contextFrom: 10,
      from: 20,
      to: 100,
      now: 100,
      events: [playerEvent("leave", "player_left", "Robin", 40)],
      snapshot: {
        state: "stale",
        online: 1,
        maxPlayers: 20,
        names: ["Robin"],
        sampledAt: new Date(80).toISOString(),
        lastAttemptAt: new Date(100).toISOString(),
        code: "QUERY_TIMEOUT",
        message: "Timed out"
      }
    });
    expect(result.onlineNames).toEqual(["Robin"]);
    expect(result.sessions).toMatchObject([{
      player: "Robin",
      startedAt: 10,
      endedAt: 40,
      startBoundary: "history-boundary",
      endBoundary: "leave"
    }, {
      player: "Robin",
      startedAt: 40,
      endedAt: null,
      startBoundary: "history-boundary",
      endBoundary: "online"
    }]);
  });

  it("replays player changes that happened after a stale snapshot", () => {
    const result = timelinePlayerActivity({
      contextFrom: 0,
      from: 0,
      to: 100,
      now: 100,
      events: [
        playerEvent("robin-left", "player_left", "Robin", 60),
        playerEvent("alex-joined", "player_joined", "Alex", 70)
      ],
      snapshot: {
        state: "stale",
        online: 1,
        maxPlayers: 20,
        names: ["Robin"],
        sampledAt: new Date(50).toISOString(),
        lastAttemptAt: new Date(100).toISOString(),
        code: "QUERY_TIMEOUT",
        message: "Timed out"
      }
    });

    expect(result.onlineNames).toEqual(["Alex"]);
    expect(result.sessions).toMatchObject([
      { player: "Robin", endedAt: 60, endBoundary: "leave" },
      { player: "Alex", startedAt: 70, endedAt: null, endBoundary: "online" }
    ]);
  });

  it("clears a stale roster after a newer server stop", () => {
    const stopped: ServerTimelineEvent = {
      id: "stopped",
      eventType: "server_stopped",
      type: "info",
      severity: "info",
      text: "Server stopped",
      message: "Server stopped",
      signature: "server_stopped",
      source: "docker",
      occurredAt: 60
    };
    const result = timelinePlayerActivity({
      contextFrom: 0,
      from: 0,
      to: 100,
      now: 100,
      events: [playerEvent("join", "player_joined", "Robin", 10), stopped],
      snapshot: {
        state: "stale",
        online: 1,
        maxPlayers: 20,
        names: ["Robin"],
        sampledAt: new Date(50).toISOString(),
        lastAttemptAt: new Date(100).toISOString(),
        code: "QUERY_TIMEOUT",
        message: "Timed out"
      }
    });

    expect(result.onlineNames).toEqual([]);
    expect(result.sessions).toMatchObject([{ player: "Robin", endedAt: 60, endBoundary: "server-end" }]);
  });
});
