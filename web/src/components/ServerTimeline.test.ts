import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ServerTimelineResponse } from "../types";
import {
  annotationPopoverDismissedByPointer,
  clusterTimelineMarkers,
  formatTimelineDuration,
  mergeTimelineResponses,
  panTimelineWindowByPixels,
  readTimelineMetricLayers,
  zoomTimelineWindowAtPixel,
  positionTimelineClusters,
  ServerTimeline,
  TimelineAnnotationPopoverItem,
  timelineAnnotationGridTop,
  timelineActiveScheduleRanges,
  timelineClusterIconMarkers,
  timelineClusterOccurrenceCount,
  timelineMarkers,
  timelineHorizontalWheelPixels,
  timelineMarkerDisplayLabel,
  timelineMarkerGlyph,
  timelinePlayerRows,
  timelineSessionGeometry,
  writeTimelineMetricLayers
} from "./ServerTimeline";

describe("server timeline controls", () => {
  it("uses the three-hour preset by default and keeps reset disabled for an unmodified preset", () => {
    const html = renderToStaticMarkup(createElement(ServerTimeline, {
      loadTimeline: vi.fn(),
      formatTime: String,
      formatShortTime: String,
      formatDate: String,
      onOpenSchedules: vi.fn()
    }));

    expect(html).toMatch(/>1h<.*>3h<.*>6h</s);
    expect(html).toMatch(/<button[^>]*aria-pressed="true"[^>]*active[^>]*>3h<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Reset view<\/button>/);
    expect(html).toContain("Player activity");
    expect(html).toContain("Server events");
    expect(html).not.toContain("serverTimelineSummary");
  });

  it("round-trips metric layer visibility and fills missing preferences from the defaults", () => {
    let saved = "";
    const storage = {
      getItem: () => saved || null,
      setItem: (_key: string, value: string) => { saved = value; }
    };
    const enabled = {
      cpuUtilizationPercent: false,
      memoryUsageBytes: true,
      networkRxBytesPerSecond: true,
      networkTxBytesPerSecond: false,
      playersOnline: true
    };

    writeTimelineMetricLayers(enabled, storage);
    expect(readTimelineMetricLayers(storage)).toEqual(enabled);

    saved = JSON.stringify({ cpuUtilizationPercent: false });
    expect(readTimelineMetricLayers(storage)).toEqual({
      cpuUtilizationPercent: false,
      memoryUsageBytes: true,
      networkRxBytesPerSecond: false,
      networkTxBytesPerSecond: false,
      playersOnline: false
    });
  });

  it("falls back to the default metric layers when the saved preference is invalid", () => {
    expect(readTimelineMetricLayers({ getItem: () => "not-json" })).toEqual({
      cpuUtilizationPercent: true,
      memoryUsageBytes: true,
      networkRxBytesPerSecond: false,
      networkTxBytesPerSecond: false,
      playersOnline: false
    });
  });

  it("renders server events inside a gutter-labelled band without a baseline", () => {
    const html = renderToStaticMarkup(createElement(ServerTimeline, {
      loadTimeline: vi.fn(),
      formatTime: String,
      formatShortTime: String,
      formatDate: String,
      onOpenSchedules: vi.fn()
    }));

    expect(html).toContain("serverTimelineEventRail");
    expect(html).toContain("serverTimelineEventRailTrack");
    expect(html).not.toContain("serverTimelineEventRailLine");
    expect(html).toContain("None in this range");
    expect(html).not.toContain("serverTimelineAnnotationStage");
  });

  it("maps horizontal trackpad and Shift-wheel input without capturing vertical roster scrolling", () => {
    expect(timelineHorizontalWheelPixels({ deltaMode: 0, deltaX: -120, deltaY: 4, shiftKey: false }, 800)).toBe(-120);
    expect(timelineHorizontalWheelPixels({ deltaMode: 1, deltaX: 0, deltaY: 3, shiftKey: true }, 800)).toBe(48);
    expect(timelineHorizontalWheelPixels({ deltaMode: 0, deltaX: 2, deltaY: 80, shiftKey: false }, 800)).toBe(0);
    expect(panTimelineWindowByPixels({ from: 1_000, to: 5_000 }, -200, 800, 10_000)).toEqual({ from: 0, to: 4_000 });
    expect(panTimelineWindowByPixels({ from: 6_000, to: 10_000 }, 200, 800, 10_000)).toEqual({ from: 6_000, to: 10_000 });
    const zoomed = zoomTimelineWindowAtPixel({ from: 0, to: 4_000_000 }, -360, 600, 800, 10_000_000);
    expect(zoomed.to - zoomed.from).toBeLessThan(4_000_000);
    expect(zoomed.from + (zoomed.to - zoomed.from) * 0.75).toBeCloseTo(3_000_000);
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
      { id: "leave", eventType: "player_left", type: "info", severity: "info", text: "Alex left", message: "Alex left", timestamp: "2026-01-01T00:00:11.000Z", occurredAt: 11_000, signature: "player_left:alex", source: "logs/latest.log", subject: "Alex" },
      { id: "started", eventType: "server_started", type: "success", severity: "success", text: "Server started", message: "Server started", timestamp: "2026-01-01T00:00:20.000Z", occurredAt: 20_000, signature: "server_started", source: "logs/latest.log" }
    ],
    schedules: [{ id: "schedule", scheduleId: "schedule-1", scheduleName: "Restart", occurredAt: 50_000, kind: "upcoming", status: "upcoming" }],
    scheduleAnnotationsAvailable: true,
    truncated: { schedules: false }
  };
}

describe("server timeline event popover dismissal", () => {
  const element = (matches: string[]) => ({
    closest: (selector: string) => matches.includes(selector) ? {} : null
  }) as unknown as Element;
  const popover = (contains: boolean) => ({ contains: () => contains });

  it("dismisses the popover for a press anywhere outside it", () => {
    expect(annotationPopoverDismissedByPointer(element([]), popover(false))).toBe(true);
  });

  it("keeps the popover open for a press inside it", () => {
    expect(annotationPopoverDismissedByPointer(element([]), popover(true))).toBe(false);
  });

  it("leaves cluster markers to their own toggle", () => {
    expect(annotationPopoverDismissedByPointer(element([".timelineAnnotationCluster"]), popover(false))).toBe(false);
  });

  it("dismisses the popover when the press has no element target", () => {
    expect(annotationPopoverDismissedByPointer(null, popover(false))).toBe(true);
  });
});

describe("server timeline markers", () => {
  it("turns active schedule markers into open duration ranges, including starts before the viewport", () => {
    const value = response();
    value.schedules = [{
      id: "active:run-1",
      scheduleId: "schedule-1",
      scheduleName: "Nightly backup",
      occurredAt: 0,
      kind: "active",
      status: "running",
      runId: "run-1",
      message: "Waiting for 2 players to leave"
    }];
    const markers = timelineMarkers(value);
    const ranges = timelineActiveScheduleRanges(markers, 60 * 60_000, 4 * 60 * 60_000, 4 * 60 * 60_000);

    expect(ranges).toMatchObject([{
      leftPercent: 0,
      widthPercent: 100,
      clippedStart: true,
      clippedEnd: false,
      align: "start",
      durationLabel: "4h 0m",
      statusLabel: "Waiting for 2 players to leave"
    }]);
    expect(ranges[0].accessibleLabel).toContain("running for 4h 0m; still running");
    expect(clusterTimelineMarkers(markers.filter((marker) => marker.schedule?.kind !== "active"), 60 * 60_000, 4 * 60 * 60_000)).toEqual([]);
  });

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

  it("maps lifecycle and schedule annotations while omitting player messages", () => {
    const markers = timelineMarkers(response());
    expect(markers.map((marker) => marker.label)).toEqual(["Server started", "Restart scheduled"]);
    expect(markers.map((marker) => marker.tone)).toEqual(["server", "planned"]);
    expect(markers.every((marker) => marker.event?.eventType !== "player_joined" && marker.event?.eventType !== "player_left")).toBe(true);
  });

  it("combines a nearby stop and start into one restart marker", () => {
    const value = response();
    value.schedules = [];
    value.events = [
      { ...value.events[2], id: "stopped", eventType: "server_stopped", message: "Server stopped", text: "Server stopped", signature: "server_stopped", occurredAt: 10_000 },
      { ...value.events[2], id: "started-again", occurredAt: 40_000 }
    ];

    const markers = timelineMarkers(value);
    expect(markers).toMatchObject([{
      id: "restart:stopped:started-again",
      occurredAt: 40_000,
      label: "Server restarted",
      restart: { durationSeconds: 30 }
    }]);
    expect(timelineMarkerDisplayLabel(markers[0])).toEqual({ primary: "Server restarted" });
  });

  it("keeps a stop and much later start as separate lifecycle markers", () => {
    const value = response();
    value.schedules = [];
    value.events = [
      { ...value.events[2], id: "stopped", eventType: "server_stopped", message: "Server stopped", text: "Server stopped", signature: "server_stopped", occurredAt: 10_000 },
      { ...value.events[2], id: "started-later", occurredAt: 320_001 }
    ];
    expect(timelineMarkers(value).map((marker) => marker.label)).toEqual(["Server stopped", "Server started"]);
  });

  it("collapses repeated lifecycle events into one counted marker", () => {
    const value = response();
    value.schedules = [];
    value.events = Array.from({ length: 9 }, (_, index) => ({
      ...value.events[2],
      id: `started-${index}`,
      occurredAt: 10_000 + index * 30_000,
      timestamp: new Date(10_000 + index * 30_000).toISOString()
    }));

    const markers = timelineMarkers(value);
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ occurrences: 9, occurredAt: 250_000, label: "Server started" });

    const html = renderToStaticMarkup(createElement(TimelineAnnotationPopoverItem, {
      marker: markers[0],
      formatDate: () => "01.01.2026, 00:04",
      onOpenSchedule: vi.fn()
    }));
    expect(html).toContain("×9");
  });

  it("clusters colliding lifecycle and schedule events without dropping their icon types", () => {
    const markers = timelineMarkers(response());
    markers[1].occurredAt = 21_000;
    const cluster = clusterTimelineMarkers(markers, 0, 60_000, 6)[0];
    expect(cluster.markers.map((marker) => marker.label)).toEqual(["Server started", "Restart scheduled"]);
    expect(timelineClusterOccurrenceCount(cluster)).toBe(2);
    expect(timelineClusterIconMarkers(cluster).map((marker) => marker.tone)).toEqual(["server", "planned"]);
  });

  it("uses a calendar glyph for scheduled runs", () => {
    const scheduleMarker = timelineMarkers(response()).find((marker) => marker.schedule)!;
    const html = renderToStaticMarkup(timelineMarkerGlyph(scheduleMarker));

    expect(html).toContain('<rect x="4" y="5" width="16" height="15" rx="2"></rect>');
    expect(html).toContain('d="M8 3v4M16 3v4M4 10h16"');
  });

  it("does not chain adjacent markers into a cluster spanning multiple buckets", () => {
    const marker = timelineMarkers(response())[0];
    const clusters = clusterTimelineMarkers([
      { ...marker, id: "first", occurredAt: 0 },
      { ...marker, id: "second", occurredAt: 59 },
      { ...marker, id: "third", occurredAt: 118 }
    ], 0, 360, 6);

    expect(clusters.map((cluster) => cluster.markers.map((item) => item.id))).toEqual([
      ["first", "second"],
      ["third"]
    ]);
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

  it("layers at most three icons while retaining the full event count", () => {
    const marker = timelineMarkers(response())[0];
    const markers = Array.from({ length: 6 }, (_, index) => ({ ...marker, id: `event-${index}`, label: `Event ${index + 1}` }));
    const cluster = clusterTimelineMarkers(markers, 0, 60_000, 1)[0];
    expect(timelineClusterIconMarkers(cluster).map((item) => item.label)).toEqual(["Event 1", "Event 2", "Event 3"]);
    expect(timelineClusterOccurrenceCount(cluster)).toBe(6);
  });

  it("keeps every annotation in one fixed-height row", () => {
    const marker = timelineMarkers(response())[0];
    const markers = Array.from({ length: 6 }, (_, index) => ({ ...marker, id: `event-${index}`, occurredAt: 10_000 + index }));
    const positioned = positionTimelineClusters(clusterTimelineMarkers(markers, 0, 60_000, 1), 0, 60_000);
    expect(positioned[0]).toMatchObject({ lane: 0, labelTop: 9, labelHeight: 30 });
    expect(timelineAnnotationGridTop(positioned)).toBe(48);
  });

  it("does not pin buffered annotations outside the visible viewport to an edge", () => {
    const markers = timelineMarkers(response());
    const clusters = clusterTimelineMarkers(markers, 21_000, 40_000, 6);
    expect(clusters).toEqual([]);
  });

  it("positions compact icons at their exact event time on the single lane", () => {
    const clusters = clusterTimelineMarkers(timelineMarkers(response()), 0, 60_000, 24);
    const positioned = positionTimelineClusters(clusters, 0, 60_000, 1_800);
    expect(positioned[0].leftPercent).toBeCloseTo(33.333);
    expect(positioned[1].leftPercent).toBeCloseTo(83.333);
    expect(positioned.map((cluster) => cluster.lane)).toEqual([0, 0]);
    expect(positioned.map((cluster) => cluster.inlineLabel)).toEqual(["Server started", "Restart"]);
  });

  it("only shows an inline event label when it fits to the right without colliding", () => {
    const marker = timelineMarkers(response())[0];
    const separated = [
      { ...marker, id: "first", occurredAt: 10_000 },
      { ...marker, id: "second", occurredAt: 40_000 }
    ];
    const crowded = [
      { ...marker, id: "first", occurredAt: 10_000 },
      { ...marker, id: "second", occurredAt: 14_000 }
    ];

    expect(positionTimelineClusters(clusterTimelineMarkers(separated, 0, 60_000, 24), 0, 60_000, 1_000).map((cluster) => cluster.inlineLabel))
      .toEqual(["Server started", "Server started"]);
    expect(positionTimelineClusters(clusterTimelineMarkers(crowded, 0, 60_000, 24), 0, 60_000, 1_000).map((cluster) => cluster.inlineLabel))
      .toEqual([null, "Server started"]);
  });

  it("keeps a compact cluster inside the right edge", () => {
    const marker = { ...timelineMarkers(response())[0], occurredAt: 59_000, occurrences: 12 };
    const positioned = positionTimelineClusters(clusterTimelineMarkers([marker], 0, 60_000, 24), 0, 60_000, 300);
    expect(positioned[0]).toMatchObject({ alignEnd: true, lane: 0 });
  });

  it("keeps a single marker icon-only when its label would cross the right edge", () => {
    const marker = { ...timelineMarkers(response())[0], occurredAt: 59_000 };
    const positioned = positionTimelineClusters(clusterTimelineMarkers([marker], 0, 60_000, 24), 0, 60_000, 300);
    expect(positioned[0]).toMatchObject({ alignEnd: true, inlineLabel: null });
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
    expect(merged.events.map((event) => event.id)).toEqual(["started", "leave"]);
    expect(merged.schedules).toHaveLength(1);
    expect(merged.from).toBe(15_000);
  });

  it("merges open player sessions by stable identity", () => {
    const current = response();
    current.playerActivity = {
      snapshotState: "live",
      sampledAt: new Date(50_000).toISOString(),
      onlineNames: ["Alex"],
      sessions: [{ id: "alex:10", player: "Alex", startedAt: 10_000, endedAt: null, startBoundary: "join", endBoundary: "online" }]
    };
    const incoming = response();
    incoming.playerActivity = {
      snapshotState: "live",
      sampledAt: new Date(65_000).toISOString(),
      onlineNames: [],
      sessions: [{ id: "alex:10", player: "Alex", startedAt: 10_000, endedAt: 60_000, startBoundary: "join", endBoundary: "leave" }]
    };
    const merged = mergeTimelineResponses(current, incoming, 15_000, 65_000);
    expect(merged.playerActivity).toMatchObject({ onlineNames: [], sessions: [{ id: "alex:10", endedAt: 60_000, endBoundary: "leave" }] });
  });

  it("replaces rolling history-boundary sessions instead of accumulating seven-day bars", () => {
    const current = response();
    current.playerActivity = {
      snapshotState: "live",
      onlineNames: ["Alex"],
      sessions: [{ id: "alex:old-boundary", player: "Alex", startedAt: 1_000, endedAt: null, startBoundary: "history-boundary", endBoundary: "online" }]
    };
    const incoming = response();
    incoming.from = 45_000;
    incoming.to = 65_000;
    incoming.playerActivity = {
      snapshotState: "live",
      onlineNames: ["Alex"],
      sessions: [{ id: "alex:new-boundary", player: "Alex", startedAt: 2_000, endedAt: null, startBoundary: "history-boundary", endBoundary: "online" }]
    };

    expect(mergeTimelineResponses(current, incoming, 0, 65_000).playerActivity?.sessions)
      .toEqual([incoming.playerActivity.sessions[0]]);
  });

  it("deduplicates an event when its rolling log-tail line index changes", () => {
    const current = response();
    current.events = [{ ...current.events[0], id: "logs-199-old" }];
    const incoming = response();
    incoming.events = [{ ...current.events[0], id: "logs-198-new" }];

    expect(mergeTimelineResponses(current, incoming, 0, 60_000).events.map((event) => event.id)).toEqual(["logs-198-new"]);
  });

  it("removes an upcoming marker after its scheduled time passes", () => {
    const current = response();
    current.schedules = [{ id: "upcoming", scheduleId: "schedule-1", scheduleName: "Restart", occurredAt: 50_000, kind: "upcoming", status: "upcoming" }];
    const incoming = response();
    incoming.generatedAt = new Date(60_000).toISOString();
    incoming.schedules = [];

    expect(mergeTimelineResponses(current, incoming, 0, 60_000).schedules).toEqual([]);
  });
});

describe("server timeline player sessions", () => {
  it("keeps last-confirmed names online while a snapshot is temporarily stale", () => {
    const value = response();
    value.playerActivity = {
      snapshotState: "stale",
      sampledAt: new Date(50_000).toISOString(),
      onlineNames: ["Alex"],
      sessions: [{ id: "alex", player: "Alex", startedAt: 10_000, endedAt: null, startBoundary: "join", endBoundary: "online" }]
    };

    expect(timelinePlayerRows(value, { from: 0, to: 60_000 }, 50_000)).toMatchObject([{ player: "Alex", online: true }]);
  });

  it("groups online players first and keeps offline activity range-relevant", () => {
    const value = response();
    value.playerActivity = {
      snapshotState: "live",
      onlineNames: ["Zoe", "Alex"],
      sessions: [
        { id: "zoe", player: "Zoe", startedAt: 5_000, endedAt: null, startBoundary: "join", endBoundary: "online" },
        { id: "sam", player: "Sam", startedAt: 20_000, endedAt: 30_000, startBoundary: "join", endBoundary: "leave" },
        { id: "old", player: "OldPlayer", startedAt: -20_000, endedAt: -10_000, startBoundary: "join", endBoundary: "leave" }
      ]
    };
    expect(timelinePlayerRows(value, { from: 0, to: 60_000 }, 50_000).map((row) => [row.player, row.online])).toEqual([
      ["Alex", true],
      ["Zoe", true],
      ["Sam", false]
    ]);
  });

  it("does not let the latest live roster reorder a historical player range", () => {
    const value = response();
    value.playerActivity = {
      snapshotState: "live",
      onlineNames: ["LatestPlayer"],
      sessions: [
        { id: "latest", player: "LatestPlayer", startedAt: 80_000, endedAt: null, startBoundary: "join", endBoundary: "online" },
        { id: "historical", player: "HistoricalPlayer", startedAt: 20_000, endedAt: 30_000, startBoundary: "join", endBoundary: "leave" }
      ]
    };
    expect(timelinePlayerRows(value, { from: 10_000, to: 40_000 }, 100_000).map((row) => [row.player, row.online]))
      .toEqual([["HistoricalPlayer", false]]);
  });

  it("keeps a visible open session online when now is outside the viewport", () => {
    const value = response();
    value.playerActivity = {
      snapshotState: "live",
      onlineNames: ["Alex"],
      sessions: [
        { id: "alex-open", player: "Alex", startedAt: 10_000, endedAt: null, startBoundary: "join", endBoundary: "online" }
      ]
    };

    expect(timelinePlayerRows(value, { from: 20_000, to: 40_000 }, 100_000)).toMatchObject([
      { player: "Alex", online: true, sessions: [{ id: "alex-open", endBoundary: "online" }] }
    ]);
  });

  it("clips incomplete sessions and reports lower-bound durations", () => {
    const geometry = timelineSessionGeometry({
      id: "clipped",
      player: "Alex",
      startedAt: 0,
      endedAt: null,
      startBoundary: "history-boundary",
      endBoundary: "online"
    }, { from: 10_000, to: 40_000 }, 30_000)!;
    expect(geometry).toMatchObject({ leftPercent: 0, widthPercent: 66.66666666666666, startClipped: true, endClipped: false, lowerBound: true });
    expect(formatTimelineDuration(4 * 60 * 60_000 + 25 * 60_000)).toBe("4h 25m");
  });
});
