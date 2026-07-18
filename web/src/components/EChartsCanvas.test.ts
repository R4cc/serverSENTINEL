import { describe, expect, it, vi } from "vitest";
import type { EChartsCoreOption } from "echarts/core";
import { createChartOptionScheduler, timelineChartInteractionOption, timelineChartSetOptionOptions } from "./EChartsCanvas";

describe("timeline chart option application", () => {
  it("applies complete resource options synchronously", () => {
    expect(timelineChartSetOptionOptions).toEqual({ notMerge: true });
    expect(timelineChartSetOptionOptions).not.toHaveProperty("lazyUpdate");
  });
});

describe("timeline chart option scheduling", () => {
  it("defers React option updates until an active drag finishes", () => {
    const apply = vi.fn();
    const applyDuringInteraction = vi.fn();
    const scheduler = createChartOptionScheduler(apply, applyDuringInteraction);
    const initial = { xAxis: { min: 0, max: 100 } } satisfies EChartsCoreOption;
    const firstDragUpdate = { xAxis: { min: 10, max: 110 } } satisfies EChartsCoreOption;
    const finalDragUpdate = { xAxis: { min: 50, max: 150 } } satisfies EChartsCoreOption;

    scheduler.update(initial);
    scheduler.startInteraction();
    scheduler.update(firstDragUpdate);
    scheduler.update(finalDragUpdate);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenLastCalledWith(initial);
    expect(applyDuringInteraction).toHaveBeenCalledTimes(2);
    expect(applyDuringInteraction).toHaveBeenLastCalledWith(finalDragUpdate);

    scheduler.finishInteraction();
    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith(finalDragUpdate);
  });

  it("extracts only interaction-safe Y-axis changes from a full option", () => {
    expect(timelineChartInteractionOption({
      xAxis: { min: 10, max: 20 },
      yAxis: [{ min: 60, max: 70 }],
      dataZoom: [{ startValue: 10, endValue: 20 }]
    })).toEqual({ animation: false, yAxis: [{ min: 60, max: 70 }] });
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
