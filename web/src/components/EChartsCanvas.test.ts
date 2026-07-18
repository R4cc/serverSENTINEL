import { describe, expect, it, vi } from "vitest";
import type { EChartsCoreOption } from "echarts/core";
import { createChartOptionScheduler, timelineChartSetOptionOptions } from "./EChartsCanvas";

describe("timeline chart option application", () => {
  it("atomically replaces chart components while preserving their stable identities", () => {
    expect(timelineChartSetOptionOptions).toEqual({
      replaceMerge: ["grid", "xAxis", "yAxis", "dataZoom", "series"],
      lazyUpdate: false,
      silent: true
    });
    expect(timelineChartSetOptionOptions).not.toHaveProperty("notMerge");
  });
});

describe("timeline chart option scheduling", () => {
  it("defers React option updates until an active drag finishes", () => {
    const apply = vi.fn();
    const scheduler = createChartOptionScheduler(apply);
    const initial = { xAxis: { min: 0, max: 100 } } satisfies EChartsCoreOption;
    const firstDragUpdate = { xAxis: { min: 10, max: 110 } } satisfies EChartsCoreOption;
    const finalDragUpdate = { xAxis: { min: 50, max: 150 } } satisfies EChartsCoreOption;

    scheduler.update(initial);
    scheduler.startInteraction();
    scheduler.update(firstDragUpdate);
    scheduler.update(finalDragUpdate);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(initial);
    scheduler.finishInteraction();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(finalDragUpdate);
  });

  it("drops a pending option when the chart is disposed", () => {
    const apply = vi.fn();
    const scheduler = createChartOptionScheduler(apply);
    scheduler.startInteraction();
    scheduler.update({ xAxis: { min: 10, max: 20 } });
    scheduler.cancel();
    scheduler.finishInteraction();
    expect(apply).not.toHaveBeenCalled();
  });
});
