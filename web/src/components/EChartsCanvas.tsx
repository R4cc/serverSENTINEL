import { useEffect, useRef } from "react";
import { LineChart } from "echarts/charts";
import {
  AriaComponent,
  DataZoomInsideComponent,
  GridComponent,
  MarkLineComponent,
  TooltipComponent
} from "echarts/components";
import { init, use, type EChartsCoreOption, type EChartsType } from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";

use([
  LineChart,
  AriaComponent,
  DataZoomInsideComponent,
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
  CanvasRenderer
]);

export type TimelineDataZoomEvent = {
  start?: number;
  end?: number;
  startValue?: number;
  endValue?: number;
  batch?: TimelineDataZoomEvent[];
};

export function EChartsCanvas({
  option,
  onDataZoom
}: {
  option: EChartsCoreOption;
  onDataZoom: (event: TimelineDataZoomEvent) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const onDataZoomRef = useRef(onDataZoom);
  onDataZoomRef.current = onDataZoom;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = init(container, undefined, { renderer: "canvas", useDirtyRect: true });
    chartRef.current = chart;
    const handleDataZoom = (event: unknown) => onDataZoomRef.current(event as TimelineDataZoomEvent);
    chart.on("datazoom", handleDataZoom);
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
      chart.off("datazoom", handleDataZoom);
      chart.dispose();
      if (chartRef.current === chart) chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setOption(option, { notMerge: true, lazyUpdate: true });
  }, [option]);

  return <div ref={containerRef} className="serverTimelineEChart" />;
}
