import { describe, expect, it } from "vitest";
import { defaultTimelinePalette } from "./serverTimelineChart";
import {
  buildPlayerTimelineChartOption,
  playerTimelineChartItems,
  playerTimelineLanePositionFromZoom,
  playerTimelineLabelLayout,
  playerTimelineLanes,
  playerTimelineReconnectWindowMs,
  playerTimelineRowsDataZoomId,
  playerTimelineRowsSliderId,
  playerTimelineTimeDataZoomId,
  resolvePlayerTimelineLaneWindow,
  type PlayerTimelineRow
} from "./playerTimelineChart";

const viewport = { from: 10_000, to: 70_000 };
const query = { from: 0, to: 80_000 };
const formatShortTime = (value: string | number | Date) => `${Number(value) / 1_000}s`;

function rows(): PlayerTimelineRow[] {
  return [
    {
      player: "Alex",
      online: true,
      sessions: [{
        id: "alex-open",
        player: "Alex",
        startedAt: 0,
        endedAt: null,
        startBoundary: "history-boundary",
        endBoundary: "online"
      }]
    },
    {
      player: "Sam",
      online: false,
      sessions: [{
        id: "sam-complete",
        player: "Sam",
        startedAt: 20_000,
        endedAt: 40_000,
        startBoundary: "join",
        endBoundary: "leave"
      }]
    }
  ];
}

describe("player timeline chart items", () => {
  it("keeps clipped lower bounds and active endpoints explicit", () => {
    const items = playerTimelineChartItems(rows(), viewport, 60_000, formatShortTime);
    expect(items).toMatchObject([
      {
        id: "alex-open",
        rowIndex: 0,
        online: true,
        visibleStart: 10_000,
        visibleEnd: 60_000,
        startClipped: true,
        endClipped: false,
        open: true,
        durationLabel: "≥ 1m",
        startLabel: null,
        endLabel: "Now"
      },
      {
        id: "sam-complete",
        rowIndex: 1,
        online: false,
        exactStart: true,
        exactEnd: true,
        startLabel: "20s",
        endLabel: "40s"
      }
    ]);
  });

  it("uses a continuation cue instead of an open endpoint when now is outside a historical viewport", () => {
    const items = playerTimelineChartItems(rows().slice(0, 1), { from: 10_000, to: 30_000 }, 60_000, formatShortTime);
    expect(items[0]).toMatchObject({ visibleEnd: 30_000, open: false, endClipped: true, endLabel: null });
  });

  it("collapses quick leave and join bursts into one range with reconnect markers", () => {
    const minute = 60_000;
    const items = playerTimelineChartItems([{
      player: "Alex",
      online: true,
      sessions: [
        { id: "one", player: "Alex", startedAt: 0, endedAt: 4 * minute, startBoundary: "join", endBoundary: "leave" },
        { id: "two", player: "Alex", startedAt: 5 * minute, endedAt: 9 * minute, startBoundary: "join", endBoundary: "leave" },
        { id: "three", player: "Alex", startedAt: 12 * minute, endedAt: null, startBoundary: "join", endBoundary: "online" }
      ]
    }], { from: 0, to: 30 * minute }, 20 * minute, formatShortTime);

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "one+two+three",
      visibleStart: 0,
      visibleEnd: 20 * minute,
      durationLabel: "16m active",
      startLabel: "0s",
      endLabel: "Now",
      reconnects: [
        { at: 5 * minute, offlineMs: minute },
        { at: 12 * minute, offlineMs: 3 * minute }
      ]
    });
    expect(items[0].accessibleLabel).toContain("2 reconnects");
  });

  it("keeps gaps over 15 minutes and server-stop boundaries separate", () => {
    const minute = 60_000;
    const sessions: PlayerTimelineRow["sessions"] = [
      { id: "quick-one", player: "Alex", startedAt: 0, endedAt: minute, startBoundary: "join", endBoundary: "leave" },
      { id: "quick-two", player: "Alex", startedAt: minute + playerTimelineReconnectWindowMs, endedAt: 20 * minute, startBoundary: "join", endBoundary: "leave" },
      { id: "long-gap", player: "Alex", startedAt: 36 * minute, endedAt: 40 * minute, startBoundary: "join", endBoundary: "server-end" },
      { id: "after-stop", player: "Alex", startedAt: 41 * minute, endedAt: 45 * minute, startBoundary: "join", endBoundary: "leave" }
    ];
    const items = playerTimelineChartItems(
      [{ player: "Alex", online: false, sessions }],
      { from: 0, to: 60 * minute },
      60 * minute,
      formatShortTime
    );

    expect(items.map((item) => item.id)).toEqual(["quick-one+quick-two", "long-gap", "after-stop"]);
    expect(items[0].reconnects).toEqual([{ at: 16 * minute, offlineMs: playerTimelineReconnectWindowMs }]);
  });
});

describe("player timeline label placement", () => {
  it("moves short-session endpoints outside the segment when space permits", () => {
    const layout = playerTimelineLabelLayout({
      startX: 100,
      endX: 125,
      plotLeft: 0,
      plotRight: 500,
      durationWidth: 24,
      startWidth: 28,
      endWidth: 28,
      hasStart: true,
      hasEnd: true
    });
    expect(layout).toMatchObject({ startAlign: "right", endAlign: "left", showStart: true, showEnd: true });
    expect(layout.startX).toBeLessThan(100);
    expect(layout.endX).toBeGreaterThan(125);
  });

  it("keeps duration labels inside the plot at viewport edges", () => {
    const layout = playerTimelineLabelLayout({
      startX: 0,
      endX: 2,
      plotLeft: 0,
      plotRight: 200,
      durationWidth: 58,
      startWidth: 0,
      endWidth: 0,
      hasStart: false,
      hasEnd: false
    });
    expect(layout.durationX).toBeGreaterThan(20);
    expect(layout.durationX).toBeLessThan(180);
  });
});

describe("player timeline lanes", () => {
  it("uses dedicated group lanes and stable online-first player keys", () => {
    expect(playerTimelineLanes(rows()).map((lane) => lane.key)).toEqual([
      "group:online",
      "player:online:alex",
      "group:offline",
      "player:offline:sam"
    ]);
  });

  it("omits empty groups and keeps a valid vertical window after rows change", () => {
    const lanes = playerTimelineLanes(rows().slice(1));
    expect(lanes.map((lane) => lane.key)).toEqual(["group:offline", "player:offline:sam"]);
    expect(resolvePlayerTimelineLaneWindow(lanes, { startKey: "missing", startIndex: 9 })).toMatchObject({
      startIndex: 0,
      startKey: "group:offline",
      endKey: "player:offline:sam"
    });
  });

  it("routes only row data-zoom events into the vertical lane position", () => {
    const lanes = playerTimelineLanes(rows());
    expect(playerTimelineLanePositionFromZoom({ dataZoomId: playerTimelineRowsDataZoomId, startValue: "group:offline" }, lanes))
      .toEqual({ startKey: "group:offline", startIndex: 2 });
    expect(playerTimelineLanePositionFromZoom({ dataZoomId: playerTimelineTimeDataZoomId, startValue: viewport.from }, lanes)).toBeNull();
  });
});

describe("player timeline ECharts option", () => {
  it("renders sessions as a synchronized custom range series", () => {
    const chartRows = [
      ...rows(),
      ...Array.from({ length: 5 }, (_, index): PlayerTimelineRow => ({
        player: `Offline ${index + 1}`,
        online: false,
        sessions: []
      }))
    ];
    const option = buildPlayerTimelineChartOption({
      rows: chartRows,
      query,
      viewport,
      now: 60_000,
      palette: defaultTimelinePalette,
      formatShortTime
    }) as Record<string, unknown>;
    const series = option.series as Array<Record<string, unknown>>;
    const dataZoom = (option.dataZoom as Array<Record<string, unknown>>)[0];
    const xAxis = option.xAxis as Record<string, unknown>;
    const yAxis = option.yAxis as Record<string, unknown>;

    expect(series.map((entry) => entry.type)).toEqual(["custom", "custom", "custom"]);
    expect(series[0]).toMatchObject({ id: "player-row-chrome", coordinateSystem: "cartesian2d", silent: true, clip: false });
    expect(series[1]).toMatchObject({ id: "player-sessions", coordinateSystem: "cartesian2d", silent: true, clip: true });
    expect(typeof series[1].renderItem).toBe("function");
    expect(dataZoom).toMatchObject({ id: playerTimelineTimeDataZoomId, startValue: viewport.from, endValue: viewport.to, filterMode: "weakFilter" });
    expect((option.dataZoom as Array<Record<string, unknown>>).map((zoom) => zoom.id)).toEqual([
      playerTimelineTimeDataZoomId,
      playerTimelineRowsDataZoomId,
      playerTimelineRowsSliderId
    ]);
    expect(xAxis).toMatchObject({ min: query.from, max: query.to, position: "top" });
    expect(yAxis.data).toEqual([
      "group:online",
      "player:online:alex",
      "group:offline",
      "player:offline:offline 1",
      "player:offline:offline 2",
      "player:offline:offline 3",
      "player:offline:offline 4",
      "player:offline:offline 5",
      "player:offline:sam"
    ]);
  });

  it("uses configured same-origin player heads for row icons", () => {
    const option = buildPlayerTimelineChartOption({
      rows: rows(),
      query,
      viewport,
      now: 60_000,
      palette: defaultTimelinePalette,
      formatShortTime,
      playerHeadSource: (player) => `/player-head/${encodeURIComponent(player)}`
    }) as Record<string, unknown>;
    const rowSeries = (option.series as Array<Record<string, unknown>>)[0];
    const renderItem = rowSeries.renderItem as (params: unknown, api: unknown) => {
      children: Array<{ type: string; style?: { image?: string } }>;
    };
    const rendered = renderItem(
      { dataIndex: 1, coordSys: { x: 220, y: 30, width: 700, height: 240 } },
      { coord: () => [220, 70], size: () => [0, 40] }
    );

    expect(rendered.children.find((child) => child.type === "image")?.style?.image).toBe("/player-head/Alex");
    expect(rendered.children.some((child) => child.type === "circle" || child.type === "path")).toBe(false);
  });

  it("uses the player event glyph only as a fallback when no head is configured", () => {
    const option = buildPlayerTimelineChartOption({
      rows: rows(),
      query,
      viewport,
      now: 60_000,
      palette: defaultTimelinePalette,
      formatShortTime
    }) as Record<string, unknown>;
    const rowSeries = (option.series as Array<Record<string, unknown>>)[0];
    const renderItem = rowSeries.renderItem as (params: unknown, api: unknown) => {
      children: Array<{ type: string }>;
    };
    const rendered = renderItem(
      { dataIndex: 1, coordSys: { x: 220, y: 30, width: 700, height: 240 } },
      { coord: () => [220, 70], size: () => [0, 40] }
    );

    expect(rendered.children.some((child) => child.type === "image")).toBe(false);
    expect(rendered.children.filter((child) => child.type === "circle" || child.type === "path")).toHaveLength(3);
  });

  it("keeps a large synthetic session set in one SVG-oriented option", () => {
    const minute = 60_000;
    const syntheticRows = Array.from({ length: 100 }, (_, playerIndex): PlayerTimelineRow => ({
      player: `Load Player ${playerIndex + 1}`,
      online: playerIndex < 10,
      sessions: Array.from({ length: 25 }, (_, sessionIndex) => {
        const startedAt = sessionIndex * 25 * minute;
        return {
          id: `load-${playerIndex}-${sessionIndex}`,
          player: `Load Player ${playerIndex + 1}`,
          startedAt,
          endedAt: startedAt + 5 * minute,
          startBoundary: "join" as const,
          endBoundary: "leave" as const
        };
      })
    }));
    const largeViewport = { from: 0, to: 24 * 60 * minute };
    const option = buildPlayerTimelineChartOption({
      rows: syntheticRows,
      query: largeViewport,
      viewport: largeViewport,
      now: largeViewport.to,
      palette: defaultTimelinePalette,
      formatShortTime
    }) as Record<string, unknown>;
    const sessionSeries = (option.series as Array<Record<string, unknown>>).find((series) => series.id === "player-sessions");

    expect(sessionSeries?.data).toHaveLength(2_500);
    expect((option.yAxis as Record<string, unknown>).data).toHaveLength(102);
    expect((option.aria as Record<string, unknown>).description).toContain("Player session timeline");
  });
});
