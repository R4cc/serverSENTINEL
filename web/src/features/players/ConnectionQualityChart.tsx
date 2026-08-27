import { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerLatencyPoint } from "../../types";
import { EChartsCanvas } from "../../components/EChartsCanvas";
import { EmptyState } from "../../components/UiPrimitives";
import { formatEstimatedLatency, unknownValue } from "./playerInsightsView";
import {
  buildConnectionQualityChartOption,
  defaultConnectionQualityPalette,
  type ConnectionQualityPalette
} from "./connectionQualityChartOptions";

function readPalette(element: HTMLElement): ConnectionQualityPalette {
  const styles = getComputedStyle(element);
  const read = (property: string, fallback: string) => styles.getPropertyValue(property).trim() || fallback;
  return {
    median: read("--sentinel-success", defaultConnectionQualityPalette.median),
    accent: read("--accent", defaultConnectionQualityPalette.accent),
    text: read("--text", defaultConnectionQualityPalette.text),
    textMuted: read("--text-muted", defaultConnectionQualityPalette.textMuted),
    border: read("--border-muted", defaultConnectionQualityPalette.border),
    surface: read("--surface-raised", defaultConnectionQualityPalette.surface),
    fontFamily: read("--font-sans", defaultConnectionQualityPalette.fontFamily)
  };
}

export function ConnectionQualityChart({
  points,
  timeZone,
  compact
}: {
  points: readonly PlayerLatencyPoint[];
  timeZone: string;
  compact: boolean;
}) {
  const measured = points.filter((point) => point.medianEstimatedLatencyMs !== undefined);
  const rootRef = useRef<HTMLDivElement>(null);
  const [palette, setPalette] = useState<ConnectionQualityPalette>(defaultConnectionQualityPalette);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const update = () => {
      const next = readPalette(root);
      setPalette((current) => JSON.stringify(current) === JSON.stringify(next) ? current : next);
    };
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const shell = root.closest(".appShell");
    if (shell) observer.observe(shell, { attributes: true, attributeFilter: ["class"] });
    update();
    return () => observer.disconnect();
  }, []);

  const option = useMemo(() => measured.length < 2 ? undefined : buildConnectionQualityChartOption({
    points,
    timeZone,
    compact,
    palette
  }), [compact, measured.length, palette, points, timeZone]);

  if (measured.length < 2) {
    return (
      <EmptyState
        compact
        title="Not enough history yet"
        message="The estimate is drawn from the joins and leaves the panel has recorded. It fills in as players come and go."
      />
    );
  }

  const latest = measured.at(-1)!;
  const sampledPoints = `${measured.length} / ${points.length}`;

  return (
    <div className="playerConnectionQuality" ref={rootRef}>
      <dl className="playerConnectionSnapshot" aria-label="Latest connection quality estimate">
        <div>
          <dt><i className="playerChartSwatch playerChartSwatch--median" aria-hidden="true" />Median</dt>
          <dd>{formatEstimatedLatency(latest.medianEstimatedLatencyMs)}</dd>
        </div>
        <div>
          <dt><i className="playerChartSwatch playerChartSwatch--p95" aria-hidden="true" />95th percentile</dt>
          <dd>{formatEstimatedLatency(latest.p95EstimatedLatencyMs)}</dd>
        </div>
        <div>
          <dt>Active players</dt>
          <dd>{Number.isFinite(latest.players) ? latest.players : unknownValue}</dd>
        </div>
      </dl>
      <div className="playerLatencyChart">
        {option && (
          <EChartsCanvas
            key={`${palette.surface}:${palette.text}:${palette.accent}:${palette.median}`}
            className="playerConnectionEChart"
            option={option}
            ariaLabel={`Estimated connection quality over time. Latest median ${formatEstimatedLatency(latest.medianEstimatedLatencyMs)}, 95th percentile ${formatEstimatedLatency(latest.p95EstimatedLatencyMs)}, with ${latest.players} active players.`}
          />
        )}
      </div>
      <p className="playerConnectionCoverage">{sampledPoints} reconstructed samples had enough location data to estimate latency. Hover the chart for details.</p>
    </div>
  );
}
