import { useEffect, useRef } from "react";
import { CustomChart, LineChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  MarkLineComponent
} from "echarts/components";
import { init, use, type EChartsCoreOption, type EChartsType } from "echarts/core";
import { SVGRenderer } from "echarts/renderers";

use([
  LineChart,
  CustomChart,
  AriaComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
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
  replaceMerge: ["grid", "xAxis", "yAxis", "dataZoom", "series"],
  lazyUpdate: false,
  silent: true
};

export type TimelineDataZoomEvent = {
  dataZoomId?: string;
  start?: number;
  end?: number;
  startValue?: unknown;
  endValue?: unknown;
  batch?: TimelineDataZoomEvent[];
};

export function createChartOptionScheduler(apply: (option: EChartsCoreOption) => void) {
  let interacting = false;
  let pending: EChartsCoreOption | undefined;
  return {
    startInteraction() {
      interacting = true;
    },
    update(option: EChartsCoreOption) {
      if (interacting) {
        pending = option;
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

type ChartPointerPosition = { offsetX?: number; offsetY?: number };

export function createChartInteractionTracker(onStart: () => void, onFinish: () => void, threshold = 3) {
  let pointerDown: { x: number; y: number } | undefined;
  let dragging = false;
  const coordinates = (event: unknown) => {
    const position = event as ChartPointerPosition;
    const x = Number(position?.offsetX);
    const y = Number(position?.offsetY);
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
  };
  const finish = () => {
    pointerDown = undefined;
    if (!dragging) return;
    dragging = false;
    onFinish();
  };
  return {
    pointerDown(event: unknown) {
      pointerDown = coordinates(event);
      dragging = false;
    },
    pointerMove(event: unknown) {
      const current = coordinates(event);
      if (!pointerDown || !current || dragging) return;
      if (Math.hypot(current.x - pointerDown.x, current.y - pointerDown.y) < threshold) return;
      dragging = true;
      onStart();
    },
    pointerUp: finish,
    pointerOut: finish,
    cancel() {
      pointerDown = undefined;
      dragging = false;
    }
  };
}

export function EChartsCanvas({
  option,
  onDataZoom,
  onInteractionChange,
  onPointerMove,
  onPointerLeave,
  onClick,
  onWheel
}: {
  option: EChartsCoreOption;
  onDataZoom: (event: TimelineDataZoomEvent) => void;
  onInteractionChange?: (interacting: boolean) => void;
  onPointerMove?: React.PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: React.PointerEventHandler<HTMLDivElement>;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
  onWheel?: (event: globalThis.WheelEvent) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const optionSchedulerRef = useRef<ReturnType<typeof createChartOptionScheduler> | null>(null);
  const onDataZoomRef = useRef(onDataZoom);
  const onInteractionChangeRef = useRef(onInteractionChange);
  const onWheelRef = useRef(onWheel);
  onDataZoomRef.current = onDataZoom;
  onInteractionChangeRef.current = onInteractionChange;
  onWheelRef.current = onWheel;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = init(container, undefined, timelineChartInitOptions);
    chartRef.current = chart;
    const optionScheduler = createChartOptionScheduler((next) => chart.setOption(next, timelineChartSetOptionOptions));
    optionSchedulerRef.current = optionScheduler;
    const handleDataZoom = (event: unknown) => onDataZoomRef.current(event as TimelineDataZoomEvent);
    const handleWheel = (event: globalThis.WheelEvent) => onWheelRef.current?.(event);
    chart.on("datazoom", handleDataZoom);
    // Let the shared timeline wheel router claim horizontal pan and modified
    // zoom gestures before ECharts' inside-zoom handlers see them. Unclaimed
    // vertical wheel input continues to ECharts for player-row scrolling.
    container.addEventListener("wheel", handleWheel, { passive: false, capture: true });
    const renderer = chart.getZr();
    const interactionTracker = createChartInteractionTracker(() => {
      optionScheduler.startInteraction();
      onInteractionChangeRef.current?.(true);
    }, () => {
      optionScheduler.finishInteraction();
      onInteractionChangeRef.current?.(false);
    });
    renderer.on("mousedown", interactionTracker.pointerDown);
    renderer.on("mousemove", interactionTracker.pointerMove);
    renderer.on("mouseup", interactionTracker.pointerUp);
    renderer.on("globalout", interactionTracker.pointerOut);
    // A chart that is hidden rather than unmounted reports a zero-sized box. Resizing to that
    // throws away the laid-out chart and forces a full rebuild when it comes back into view.
    const resizeObserver = new ResizeObserver(() => {
      if (container.clientWidth > 0 && container.clientHeight > 0) chart.resize();
    });
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      renderer.off("mousedown", interactionTracker.pointerDown);
      renderer.off("mousemove", interactionTracker.pointerMove);
      renderer.off("mouseup", interactionTracker.pointerUp);
      renderer.off("globalout", interactionTracker.pointerOut);
      chart.off("datazoom", handleDataZoom);
      container.removeEventListener("wheel", handleWheel, { capture: true });
      interactionTracker.cancel();
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
