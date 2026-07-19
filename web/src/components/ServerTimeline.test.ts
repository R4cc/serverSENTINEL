import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ServerTimelineResponse } from "../types";
import {
  clusterTimelineMarkers,
  mergeTimelineResponses,
  positionTimelineClusters,
  ServerTimeline,
  TimelineAnnotationPopoverItem,
  timelineAnnotationGridTop,
  timelineMarkers,
  timelineMarkerDisplayLabel,
  timelineMarkerIsImportant,
  timelineMarkerPreview
} from "./ServerTimeline";

describe("server timeline range controls", () => {
  it("offers a three-hour preset between one and six hours", () => {
    const html = renderToStaticMarkup(createElement(ServerTimeline, {
      loadTimeline: vi.fn(),
      formatTime: String,
      formatShortTime: String,
      formatDate: String,
      onOpenSchedules: vi.fn()
    }));

    expect(html).toMatch(/>1h<.*>3h<.*>6h</s);
  });
});

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
  it("renders event popover rows as non-interactive entries with absolute timestamps", () => {
    const marker = timelineMarkers(response())[0];
    const html = renderToStaticMarkup(
      createElement(TimelineAnnotationPopoverItem, {
        marker,
        formatDate: () => "01.01.2026, 00:00",
        onOpenSchedule: vi.fn()
      })
    );

    expect(html).toContain("01.01.2026, 00:00");
    expect(html).toContain("<time");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("Open Console");
  });

  it("keeps schedule popover rows interactive while showing their absolute timestamps", () => {
    const marker = timelineMarkers(response()).find((candidate) => candidate.schedule)!;
    const html = renderToStaticMarkup(
      createElement(TimelineAnnotationPopoverItem, {
        marker,
        formatDate: () => "01.01.2026, 00:01",
        onOpenSchedule: vi.fn()
      })
    );

    expect(html).toContain("<button");
    expect(html).toContain("Open Schedules");
    expect(html).toContain("01.01.2026, 00:01");
  });

  it("maps player and schedule annotations to distinct non-color labels", () => {
    const markers = timelineMarkers(response());
    expect(markers.map((marker) => marker.label)).toEqual(["Alex joined", "Alex left", "Restart scheduled"]);
    expect(markers.map((marker) => marker.tone)).toEqual(["join", "leave", "planned"]);
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

  it("collapses repeated player events within ten minutes into one counted marker", () => {
    const value = response();
    value.schedules = [];
    value.events = Array.from({ length: 9 }, (_, index) => ({
      ...value.events[1],
      id: `leave-${index}`,
      occurredAt: 10_000 + index * 30_000,
      timestamp: new Date(10_000 + index * 30_000).toISOString()
    }));

    const markers = timelineMarkers(value);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ occurrences: 9, occurredAt: 250_000, label: "Alex left" });

    const html = renderToStaticMarkup(createElement(TimelineAnnotationPopoverItem, {
      marker: markers[0],
      formatDate: () => "01.01.2026, 00:04",
      onOpenSchedule: vi.fn()
    }));
    expect(html).toContain("×9");
  });

  it("clusters colliding markers without dropping their contents", () => {
    const markers = timelineMarkers(response());
    const clusters = clusterTimelineMarkers(markers, 0, 60_000, 6);
    expect(clusters).toHaveLength(2);
    expect(clusters[0].markers.map((marker) => marker.label)).toEqual(["Alex joined", "Alex left"]);
    expect(clusters[0]).toMatchObject({ slot: 1, slotCount: 6 });
  });

  it("keeps nearby marker groups stable as a fixed-width viewport pans", () => {
    const marker = timelineMarkers(response())[0];
    const markers = [
      { ...marker, id: "first", occurredAt: 20_000 },
      { ...marker, id: "second", occurredAt: 29_000 },
      { ...marker, id: "third", occurredAt: 45_000 }
    ];
    const before = clusterTimelineMarkers(markers, 0, 60_000, 6);
    const after = clusterTimelineMarkers(markers, 1_000, 61_000, 6);
    expect(before.map((cluster) => ({ id: cluster.id, markers: cluster.markers.map((item) => item.id) })))
      .toEqual(after.map((cluster) => ({ id: cluster.id, markers: cluster.markers.map((item) => item.id) })));
  });

  it("previews four clustered events and reports the remaining count", () => {
    const marker = timelineMarkers(response())[0];
    const markers = Array.from({ length: 6 }, (_, index) => ({ ...marker, id: `event-${index}`, label: `Event ${index + 1}` }));
    const cluster = clusterTimelineMarkers(markers, 0, 60_000, 1)[0];
    const preview = timelineMarkerPreview(cluster);
    expect(preview.markers.map((item) => item.label)).toEqual(["Event 1", "Event 2", "Event 3", "Event 4"]);
    expect(preview.remaining).toBe(2);
  });

  it("grows the annotation grid to fit stacked event previews", () => {
    const marker = timelineMarkers(response())[0];
    const markers = Array.from({ length: 6 }, (_, index) => ({ ...marker, id: `event-${index}`, occurredAt: 10_000 + index }));
    const positioned = positionTimelineClusters(clusterTimelineMarkers(markers, 0, 60_000, 1), 0, 60_000);
    expect(positioned[0]).toMatchObject({ labelTop: 2, labelHeight: 140 });
    expect(timelineAnnotationGridTop(positioned)).toBe(148);
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

  it("staggers routine marker labels when their always-visible text would collide", () => {
    const clusters = clusterTimelineMarkers(timelineMarkers(response()), 0, 60_000, 24);
    clusters[1].occurredAt = 13_000;
    const positioned = positionTimelineClusters(clusters, 0, 60_000, 1_000);
    expect(positioned.map((cluster) => cluster.lane)).toEqual([0, 1]);
  });

  it("keeps nearby marker lanes stable when panning crosses label alignment thresholds", () => {
    const marker = timelineMarkers(response())[0];
    const markers = [
      { ...marker, event: undefined, id: "first", label: "A very long nearby timeline event label", occurredAt: 54_000 },
      { ...marker, event: undefined, id: "second", label: "Another very long nearby timeline event label", occurredAt: 57_000 }
    ];
    const clusters = clusterTimelineMarkers(markers, 0, 60_000, 24);
    const before = positionTimelineClusters(clusters, 0, 60_000, 1_000);
    const after = positionTimelineClusters(clusters, 5_000, 65_000, 1_000);
    expect(before.map((cluster) => cluster.alignEnd)).not.toEqual(after.map((cluster) => cluster.alignEnd));
    expect(before.map((cluster) => cluster.lane)).toEqual(after.map((cluster) => cluster.lane));
  });

  it("separates the player action from the full player-name subtitle", () => {
    const marker = timelineMarkers(response())[0];
    marker.event = { ...marker.event!, subject: "AnExtremelyLongPlayerName" };
    expect(timelineMarkerDisplayLabel(marker)).toEqual({ primary: "Player joined", secondary: "AnExtremelyLongPlayerName" });
  });

  it("keeps lifecycle and failed automation labels important while routine and planned markers stay compact", () => {
    const value = response();
    value.events.push({ id: "crash", eventType: "server_crashed", type: "error", severity: "error", text: "Server crashed", message: "Server crashed", occurredAt: 30_000, signature: "server_crashed", source: "logs/latest.log" });
    value.schedules.push({ id: "failed", scheduleId: "schedule-1", scheduleName: "Restart", occurredAt: 40_000, kind: "run", status: "failed" });
    const markers = timelineMarkers(value);
    expect(timelineMarkerIsImportant(markers.find((marker) => marker.event?.eventType === "server_crashed")!)).toBe(true);
    expect(timelineMarkerIsImportant(markers.find((marker) => marker.schedule?.status === "failed")!)).toBe(true);
    expect(timelineMarkerIsImportant(markers.find((marker) => marker.tone === "planned")!)).toBe(false);
    expect(timelineMarkerIsImportant(markers.find((marker) => marker.tone === "join")!)).toBe(false);
  });

  it("omits the schedule legend data when permission-filtered responses contain none", () => {
    const value = response();
    value.scheduleAnnotationsAvailable = false;
    value.schedules = [];
    expect(timelineMarkers(value).every((marker) => !marker.schedule)).toBe(true);
  });

  it("merges incremental refreshes and evicts items outside the moving window", () => {
    const current = response();
    current.samples = [{ sampledAt: 20_000, available: true, running: true, cpuPercent: 10, cpuUtilizationPercent: 10, memoryUsageBytes: 100, memoryLimitBytes: 200, memoryUtilizationPercent: 50, playersOnline: 1, networkRxBytesPerSecond: 1, networkTxBytesPerSecond: 2 }];
    const incoming = response();
    incoming.from = 45_000;
    incoming.to = 65_000;
    incoming.generatedAt = "2026-01-01T00:01:05.000Z";
    incoming.samples = [{ sampledAt: 60_000, available: true, running: true, cpuPercent: 20, cpuUtilizationPercent: 20, memoryUsageBytes: 120, memoryLimitBytes: 200, memoryUtilizationPercent: 60, playersOnline: 2, networkRxBytesPerSecond: 3, networkTxBytesPerSecond: 4 }];
    incoming.events = [{ ...current.events[1], occurredAt: 50_000 }];
    const merged = mergeTimelineResponses(current, incoming, 15_000, 65_000);
    expect(merged.samples.map((point) => point.sampledAt)).toEqual([20_000, 60_000]);
    expect(merged.events.map((event) => event.id)).toEqual(["leave"]);
    expect(merged.schedules).toHaveLength(1);
    expect(merged.from).toBe(15_000);
  });
});
