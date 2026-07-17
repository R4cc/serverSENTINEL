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

export type TimelineDataZoomEvent = {
  start?: number;
  end?: number;
  startValue?: number;
  endValue?: number;
  batch?: TimelineDataZoomEvent[];
};

export function EChartsCanvas({
  option,
  onDataZoom,
  onPointerMove,
  onPointerLeave,
  onClick
}: {
  option: EChartsCoreOption;
  onDataZoom: (event: TimelineDataZoomEvent) => void;
  onPointerMove?: React.PointerEventHandler<HTMLDivElement>;
  onPointerLeave?: React.PointerEventHandler<HTMLDivElement>;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<EChartsType | null>(null);
  const onDataZoomRef = useRef(onDataZoom);
  onDataZoomRef.current = onDataZoom;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = init(container, undefined, timelineChartInitOptions);
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

  return <div ref={containerRef} className="serverTimelineEChart" onPointerMove={onPointerMove} onPointerLeave={onPointerLeave} onClick={onClick} />;
}
