import { describe, expect, it } from "vitest";
import { defaultTimelinePalette } from "./serverTimelineChart";
import {
  buildPlayerTimelineChartOption,
  playerTimelineChartItems,
  playerTimelineLabelLayout,
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
});

describe("player timeline label placement", () => {
  it("moves short-session endpoints outside the segment when space permits", () => {
    const layout = playerTimelineLabelLayout({
      startX: 100,
      endX: 125,
      plotLeft: 0,
      plotRight: 500,
      durationLabel: "2m",
      startLabel: "12:01",
      endLabel: "12:03"
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
      durationLabel: "≥ 4h 25m",
      startLabel: null,
      endLabel: null
    });
    expect(layout.durationX).toBeGreaterThan(20);
    expect(layout.durationX).toBeLessThan(180);
  });
});

describe("player timeline ECharts option", () => {
  it("renders sessions as a synchronized custom range series", () => {
    const option = buildPlayerTimelineChartOption({
      rows: rows(),
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

    expect(series.map((entry) => entry.type)).toEqual(["custom", "custom"]);
    expect(series[0]).toMatchObject({ id: "player-sessions", coordinateSystem: "cartesian2d", silent: true });
    expect(typeof series[0].renderItem).toBe("function");
    expect(dataZoom).toMatchObject({ startValue: viewport.from, endValue: viewport.to, filterMode: "weakFilter" });
    expect(xAxis).toMatchObject({ min: query.from, max: query.to });
    expect(yAxis.data).toEqual(["Alex", "Sam"]);
  });
});
