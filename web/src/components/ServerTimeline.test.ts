import { describe, expect, it } from "vitest";
import type { ServerTimelineResponse } from "../types";
import {
  clusterTimelineMarkers,
  mergeTimelineResponses,
  positionTimelineClusters,
  timelineMarkers,
  timelineMarkerDisplayLabel
} from "./ServerTimeline";

function response(): ServerTimelineResponse {
  return {
    from: 0,
    to: 60_000,
    generatedAt: "2026-01-01T00:00:00.000Z",
    samples: [],
    events: [
      { id: "join", eventType: "player_joined", type: "success", severity: "success", text: "Alex joined", message: "Alex joined", timestamp: "2026-01-01T00:00:10.000Z", occurredAt: 10_000, signature: "player_joined:alex", source: "logs/latest.log", subject: "Alex" },
      { id: "leave", eventType: "player_left", type: "info", severity: "info", text: "Alex left", message: "Alex left", timestamp: "2026-01-01T00:00:11.000Z", occurredAt: 11_000, signature: "player_left:alex", source: "logs/latest.log", subject: "Alex" }
    ],
    schedules: [{ id: "schedule", scheduleId: "schedule-1", scheduleName: "Restart", occurredAt: 50_000, kind: "upcoming", status: "upcoming" }],
    scheduleAnnotationsAvailable: true,
    truncated: { schedules: false }
  };
}

describe("server timeline markers", () => {
  it("maps player and schedule annotations to distinct non-color labels", () => {
    const markers = timelineMarkers(response());
    expect(markers.map((marker) => marker.label)).toEqual(["Alex joined", "Alex left", "Restart scheduled"]);
    expect(markers.map((marker) => marker.tone)).toEqual(["join", "leave", "schedule"]);
  });

  it("combines a leave and rejoin within 30 seconds into one reconnect marker", () => {
    const value = response();
    value.events = [
      { ...value.events[1], id: "left-first", occurredAt: 10_000, timestamp: "2026-01-01T00:00:10.000Z" },
      { ...value.events[0], id: "joined-again", occurredAt: 17_000, timestamp: "2026-01-01T00:00:17.000Z" }
    ];
    const markers = timelineMarkers(value);
    expect(markers).toHaveLength(2);
    expect(markers[0]).toMatchObject({
      id: "reconnect:left-first:joined-again",
      occurredAt: 17_000,
      label: "Alex reconnected",
      tone: "join",
      reconnect: { player: "Alex", durationSeconds: 7 }
    });
    expect(timelineMarkerDisplayLabel(markers[0])).toEqual({ primary: "Player reconnected", secondary: "Alex" });
  });

  it("keeps longer disconnects as separate leave and join markers", () => {
    const value = response();
    value.events = [
      { ...value.events[1], occurredAt: 10_000 },
      { ...value.events[0], occurredAt: 41_000 }
    ];
    expect(timelineMarkers(value).map((marker) => marker.label)).toEqual(["Alex left", "Alex joined", "Restart scheduled"]);
  });

  it("clusters colliding markers without dropping their contents", () => {
    const markers = timelineMarkers(response());
    const clusters = clusterTimelineMarkers(markers, 0, 60_000, 6);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].markers.map((marker) => marker.label)).toEqual(["Alex joined", "Alex left"]);
    expect(clusters[0]).toMatchObject({ slot: 1, slotCount: 6 });
  });

  it("does not pin buffered annotations outside the visible viewport to an edge", () => {
    const markers = timelineMarkers(response());
    const clusters = clusterTimelineMarkers(markers, 20_000, 40_000, 6);
    expect(clusters).toEqual([]);
  });

  it("positions labels from their exact event time without moving distant labels into separate lanes", () => {
    const clusters = clusterTimelineMarkers(timelineMarkers(response()), 0, 60_000, 24);
    const positioned = positionTimelineClusters(clusters, 0, 60_000, 1_800);
    expect(positioned[0].leftPercent).toBeCloseTo(17.5);
    expect(positioned[1].leftPercent).toBeCloseTo(83.333);
    expect(positioned.map((cluster) => cluster.lane)).toEqual([0, 0]);
  });

  it("moves labels into another lane only when their measured widths collide", () => {
    const clusters = clusterTimelineMarkers(timelineMarkers(response()), 0, 60_000, 24);
    clusters[1].occurredAt = 13_000;
    const positioned = positionTimelineClusters(clusters, 0, 60_000, 1_000);
    expect(positioned.map((cluster) => cluster.lane)).toEqual([0, 1]);
  });

  it("separates the player action from the full player-name subtitle", () => {
    const marker = timelineMarkers(response())[0];
    marker.event = { ...marker.event!, subject: "AnExtremelyLongPlayerName" };
    expect(timelineMarkerDisplayLabel(marker)).toEqual({ primary: "Player joined", secondary: "AnExtremelyLongPlayerName" });
  });

  it("omits the schedule legend data when permission-filtered responses contain none", () => {
    const value = response();
    value.scheduleAnnotationsAvailable = false;
    value.schedules = [];
    expect(timelineMarkers(value).every((marker) => !marker.schedule)).toBe(true);
  });

  it("merges incremental refreshes and evicts items outside the moving window", () => {
    const current = response();
    current.samples = [{ sampledAt: 20_000, available: true, running: true, cpuPercent: 10, memoryUsageBytes: 100, memoryLimitBytes: 200, networkRxBytesPerSecond: 1, networkTxBytesPerSecond: 2 }];
    const incoming = response();
    incoming.from = 45_000;
    incoming.to = 65_000;
    incoming.generatedAt = "2026-01-01T00:01:05.000Z";
    incoming.samples = [{ sampledAt: 60_000, available: true, running: true, cpuPercent: 20, memoryUsageBytes: 120, memoryLimitBytes: 200, networkRxBytesPerSecond: 3, networkTxBytesPerSecond: 4 }];
    incoming.events = [{ ...current.events[1], occurredAt: 50_000 }];
    const merged = mergeTimelineResponses(current, incoming, 15_000, 65_000);
    expect(merged.samples.map((point) => point.sampledAt)).toEqual([20_000, 60_000]);
    expect(merged.events.map((event) => event.id)).toEqual(["leave"]);
    expect(merged.schedules).toHaveLength(1);
    expect(merged.from).toBe(15_000);
  });
});
