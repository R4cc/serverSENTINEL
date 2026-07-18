import { useEffect, useRef } from "react";
import { LineChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomInsideComponent,
  GridComponent,
  MarkLineComponent
} from "echarts/components";
import { init, use, type EChartsCoreOption, type EChartsType } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";

use([
  LineChart,
  AriaComponent,
  DataZoomInsideComponent,
  GridComponent,
  MarkLineComponent,
  SVGRenderer
]);

export const timelineChartInitOptions = {
  renderer: "svg" as const
};

// Resource data, theme colors, and container size can all settle during the
// initial render. Apply each complete option synchronously so a resize cannot
// overtake a deferred full replacement and leave one of the enabled series out.
export const timelineChartSetOptionOptions = {
  notMerge: true
} as const;

export type TimelineDataZoomEvent = {
  start?: number;
  end?: number;
  startValue?: number;
  endValue?: number;
  batch?: TimelineDataZoomEvent[];
};

export function timelineChartInteractionOption(option: EChartsCoreOption): EChartsCoreOption {
  const yAxis = (option as { yAxis?: EChartsCoreOption["yAxis"] }).yAxis;
  return yAxis === undefined ? {} : { animation: false, yAxis };
}

export function createChartOptionScheduler(
  apply: (option: EChartsCoreOption) => void,
  applyDuringInteraction?: (option: EChartsCoreOption) => void
) {
  let interacting = false;
  let pending: EChartsCoreOption | undefined;
  return {
    startInteraction() {
      interacting = true;
    },
    update(option: EChartsCoreOption) {
      if (interacting) {
        pending = option;
        applyDuringInteraction?.(option);
        return;
      }
      apply(option);
    },
    finishInteraction() {
      interacting = false;
      if (!pending) return;
      const next = pending;
      pending = undefined;
      apply(next);
    },
    cancel() {
      interacting = false;
      pending = undefined;
    }
  };
}

export function EChartsCanvas({
  option,
  onDataZoom,
  onInteractionChange,
  onPointerMove,
  onPointerLeave,
  onClick
}: {
  option: EChartsCoreOption;
  onDataZoom: (event: TimelineDataZoomEvent) => void;
  onInteractionChange?: (interacting: boolean) => void;
  onPointerMove?: React.PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: React.PointerEventHandler<HTMLDivElement>;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const optionSchedulerRef = useRef<ReturnType<typeof createChartOptionScheduler> | null>(null);
  const onDataZoomRef = useRef(onDataZoom);
  const onInteractionChangeRef = useRef(onInteractionChange);
  onDataZoomRef.current = onDataZoom;
  onInteractionChangeRef.current = onInteractionChange;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = init(container, undefined, timelineChartInitOptions);
    chartRef.current = chart;
    const optionScheduler = createChartOptionScheduler(
      (next) => chart.setOption(next, timelineChartSetOptionOptions),
      (next) => chart.setOption(timelineChartInteractionOption(next), { replaceMerge: ["yAxis"] })
    );
    optionSchedulerRef.current = optionScheduler;
    const handleDataZoom = (event: unknown) => onDataZoomRef.current(event as TimelineDataZoomEvent);
    chart.on("datazoom", handleDataZoom);
    const renderer = chart.getZr();
    let interacting = false;
    const startInteraction = () => {
      if (interacting) return;
      interacting = true;
      optionScheduler.startInteraction();
      onInteractionChangeRef.current?.(true);
    };
    const finishInteraction = () => {
      if (!interacting) return;
      interacting = false;
      optionScheduler.finishInteraction();
      onInteractionChangeRef.current?.(false);
    };
    renderer.on("mousedown", startInteraction);
    renderer.on("mouseup", finishInteraction);
    renderer.on("globalout", finishInteraction);
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      renderer.off("mousedown", startInteraction);
      renderer.off("mouseup", finishInteraction);
      renderer.off("globalout", finishInteraction);
      chart.off("datazoom", handleDataZoom);
      interacting = false;
      optionScheduler.cancel();
      chart.dispose();
      if (chartRef.current === chart) chartRef.current = null;
      if (optionSchedulerRef.current === optionScheduler) optionSchedulerRef.current = null;
    };
  }, []);

  useEffect(() => {
    optionSchedulerRef.current?.update(option);
  }, [option]);

  return <div ref={containerRef} className="serverTimelineEChart" onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} onClick={onClick} />;
}
