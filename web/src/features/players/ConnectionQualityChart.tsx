import { useEffect, useMemo, useRef, useState } from "react";
import type { PlayerLatencyPoint } from "../../types";
import { EChartsCanvas } from "../../components/EChartsCanvas";
import { EmptyState } from "../../components/UiPrimitives";
import { formatPing, unknownValue } from "./playerInsightsView";
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
  const measured = points.filter((point) => point.medianPingMs !== undefined);
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
    return <EmptyState compact title="Not enough history yet" />;
  }

  const latest = measured.at(-1)!;

  return (
    <div className="playerConnectionQuality" ref={rootRef}>
      <dl className="playerConnectionSnapshot" aria-label="Latest measured connection quality">
        <div>
          <dt><i className="playerChartSwatch playerChartSwatch--median" aria-hidden="true" />Median</dt>
          <dd>{formatPing(latest.medianPingMs)}</dd>
        </div>
        <div>
          <dt><i className="playerChartSwatch playerChartSwatch--p95" aria-hidden="true" />95th percentile</dt>
          <dd>{formatPing(latest.p95PingMs)}</dd>
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
            ariaLabel={`Measured connection quality over time. Latest median ${formatPing(latest.medianPingMs)}, 95th percentile ${formatPing(latest.p95PingMs)}, with ${latest.measuredPlayers} of ${latest.players} active players measured.`}
          />
        )}
      </div>
    </div>
  );
}
