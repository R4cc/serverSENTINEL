import { useEffect, useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { ManagedServer, ResourceSample, ServerStatus } from '../types';
import { parseMaxMemoryGb } from '../utils/format';
import { Button, PanelHeader } from './UiPrimitives';

export function formatUptime(startedAt?: string, running?: boolean) {
  if (!running || !startedAt || /^\d{2}:\d{2}:\d{2}$/.test(startedAt)) return "Unknown";
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "Unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function formatActivityDate(value: string | undefined, formatDate: (value: string | number | Date) => string) {
  if (!value) return "Unknown";
  if (/^\d{2}:\d{2}:\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : formatDate(value);
}

function formatRate(bytesPerSecond?: number) {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return "Unavailable";
  if (bytesPerSecond < 1024) return `${Math.max(0, bytesPerSecond).toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
}

type ChartPoint = {
  sampledAt: number;
  time: string;
  value: number | null;
};

const resourceGraphScopes = [
  { label: "1m", milliseconds: 60 * 1000 },
  { label: "5m", milliseconds: 5 * 60 * 1000 },
  { label: "15m", milliseconds: 15 * 60 * 1000 },
  { label: "1h", milliseconds: 60 * 60 * 1000 },
  { label: "All", milliseconds: null }
] as const;

type ResourceGraphScope = typeof resourceGraphScopes[number]["label"];

function useCompactResourceChart() {
  const [compact, setCompact] = useState(() => (
    typeof window !== "undefined" ? window.matchMedia("(max-width: 720px)").matches : false
  ));

  useEffect(() => {
    const query = window.matchMedia("(max-width: 720px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return compact;
}

function ResourceChartTooltip({
  active,
  payload,
  label,
  formatValue
}: {
  active?: boolean;
  payload?: readonly { value?: unknown }[];
  label?: string | number;
  formatValue: (value: number) => string;
}) {
  const rawValue = payload?.[0]?.value;
  const value = typeof rawValue === "number" ? rawValue : Number(rawValue);
  if (!active || !Number.isFinite(value)) return null;
  return (
    <div className="resourceChartTooltip">
      <strong>{formatValue(value)}</strong>
      <span>{label}</span>
    </div>
  );
}

function ResourceChart({
  samples,
  value,
  tone = "blue",
  emptyLabel = "No history yet",
  formatValue = (item) => item.toFixed(1),
  formatTime
}: {
  samples: ResourceSample[];
  value: (sample: ResourceSample, index: number, samples: ResourceSample[]) => number;
  tone?: "blue" | "green";
  emptyLabel?: string;
  formatValue?: (value: number) => string;
  formatTime: (value: string | number | Date) => string;
}) {
  const validSamples = samples.filter((sample) => sample.available && sample.running);
  const compact = useCompactResourceChart();
  if (validSamples.length < 2) return <div className="resourceChartEmpty">{emptyLabel}</div>;

  const points: ChartPoint[] = [];
  for (let i = 0; i < validSamples.length; i++) {
    const sample = validSamples[i];
    const prev = validSamples[i - 1];

    if (prev && sample.sampledAt - prev.sampledAt > 15000) {
      points.push({
        sampledAt: prev.sampledAt + 5000,
        time: formatTime(prev.sampledAt + 5000),
        value: null
      });
    }

    const val = value(sample, i, validSamples);
    points.push({
      sampledAt: sample.sampledAt,
      time: formatTime(sample.sampledAt),
      value: Number.isFinite(val) ? val : null
    });
  }

  return (
    <div className={`resourceChart ${tone}`} role="img" aria-label="Resource usage history">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={compact ? { top: 8, right: 2, bottom: 8, left: 0 } : { top: 8, right: 16, bottom: 8, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} />
          <XAxis
            dataKey="time"
            minTickGap={36}
            tickLine={false}
            axisLine
            tickMargin={8}
          />
          <YAxis
            width={compact ? 56 : 76}
            tickFormatter={formatValue}
            tickLine={false}
            axisLine
            domain={["auto", "auto"]}
          />
          <Tooltip
            content={(props) => <ResourceChartTooltip {...props} formatValue={formatValue} />}
            isAnimationActive={false}
          />
          <Line
            type="monotone"
            dataKey="value"
            dot={false}
            activeDot={{ r: 4 }}
            stroke="currentColor"
            strokeWidth={2}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export function ResourcePanel({
  server,
  samples,
  status,
  dockerSocketMounted,
  formatNumber,
  formatTime
}: {
  server: ManagedServer;
  samples: ResourceSample[];
  status: ServerStatus | null;
  dockerSocketMounted: boolean;
  formatNumber: (value: number) => string;
  formatTime: (value: string | number | Date) => string;
}) {
  const [graphScope, setGraphScope] = useState<ResourceGraphScope>("5m");
  const latest = samples.at(-1);
  const selectedScope = resourceGraphScopes.find((scope) => scope.label === graphScope) ?? resourceGraphScopes[1];
  const scopedSamples = useMemo(() => {
    if (!selectedScope.milliseconds || !latest) return samples;
    const cutoff = latest.sampledAt - selectedScope.milliseconds;
    const minimumSamples = 2;
    const filtered = samples.filter((sample) => sample.sampledAt >= cutoff);
    return filtered.length >= minimumSamples ? filtered : samples.slice(-minimumSamples);
  }, [latest, samples, selectedScope.milliseconds]);
  const hasStats = Boolean(latest?.available && latest.running);
  const statsUnavailableLabel = !dockerSocketMounted ? "Not connected" : status?.docker.running ? "Collecting" : "Not running";
  const cpu = hasStats ? latest?.cpuPercent ?? 0 : 0;
  const memoryUsage = hasStats ? latest?.memoryUsageBytes ?? 0 : 0;
  const configuredMemoryBytes = latest?.memoryLimitBytes || parseMaxMemoryGb(server.javaArgs) * 1024 * 1024 * 1024;
  const memoryPercent = hasStats && configuredMemoryBytes ? (memoryUsage / configuredMemoryBytes) * 100 : 0;
  const previousNetworkSample = [...samples].reverse().find((sample) => (
    sample !== latest
    && sample.available
    && sample.running
    && sample.networkRxBytes !== undefined
    && sample.networkTxBytes !== undefined
  ));
  const secondsBetweenSamples = latest && previousNetworkSample ? Math.max(1, (latest.sampledAt - previousNetworkSample.sampledAt) / 1000) : undefined;
  const rxRate = hasStats && latest?.networkRxBytes !== undefined && previousNetworkSample?.networkRxBytes !== undefined && secondsBetweenSamples
    ? Math.max(0, (latest.networkRxBytes - previousNetworkSample.networkRxBytes) / secondsBetweenSamples)
    : undefined;
  const txRate = hasStats && latest?.networkTxBytes !== undefined && previousNetworkSample?.networkTxBytes !== undefined && secondsBetweenSamples
    ? Math.max(0, (latest.networkTxBytes - previousNetworkSample.networkTxBytes) / secondsBetweenSamples)
    : undefined;
  const networkValue = hasStats && txRate !== undefined && rxRate !== undefined
    ? `Up ${formatRate(txRate)} / Down ${formatRate(rxRate)}`
    : hasStats
      ? "Collecting"
      : statsUnavailableLabel;
  return (
    <section className="panel resourcePanel">
      <PanelHeader
        title="Resource Usage"
        actions={<div className="resourceScopeControl" role="group" aria-label="Resource graph time range">
          {resourceGraphScopes.map((scope) => (
            <Button
              variant="ghost"
              compact
              key={scope.label}
              className={graphScope === scope.label ? "active" : ""}
              onClick={() => setGraphScope(scope.label)}
              aria-pressed={graphScope === scope.label}
            >
              {scope.label}
            </Button>
          ))}
        </div>}
      />
      <div className="resourceRows">
        <div className={`resourceRow ${hasStats ? "" : "unavailable"}`}>
          <div className="resourceMetricLabel">
            <span>Memory usage</span>
            <strong>{hasStats ? `${formatNumber(Math.round(memoryUsage / 1024 / 1024))} MB / ${formatNumber(Math.round(configuredMemoryBytes / 1024 / 1024))} MB` : statsUnavailableLabel}</strong>
            <small>{hasStats ? `${memoryPercent.toFixed(1)}%` : `Configured limit ${formatNumber(Math.round(configuredMemoryBytes / 1024 / 1024))} MB`}</small>
          </div>
          <ResourceChart samples={scopedSamples} value={(sample) => sample.memoryUsageBytes / 1024 / 1024} formatValue={(value) => `${formatNumber(Math.round(value))} MB`} formatTime={formatTime} emptyLabel={hasStats ? "Collecting history" : statsUnavailableLabel} />
        </div>
        <div className={`resourceRow ${hasStats ? "" : "unavailable"}`}>
          <div className="resourceMetricLabel">
            <span>CPU usage</span>
            <strong>{hasStats ? `${cpu.toFixed(1)}%` : statsUnavailableLabel}</strong>
            <small>{hasStats ? "Current sample" : "Start the server to collect samples"}</small>
          </div>
          <ResourceChart samples={scopedSamples} value={(sample) => sample.cpuPercent} formatValue={(value) => `${value.toFixed(1)}%`} formatTime={formatTime} emptyLabel={hasStats ? "Collecting history" : statsUnavailableLabel} />
        </div>
        <div className={`resourceRow ${hasStats ? "" : "unavailable"}`}>
          <div className="resourceMetricLabel">
            <span>Network activity</span>
            <strong>{networkValue}</strong>
            <small>{hasStats ? "Current transfer rate" : "Start the server to collect network activity"}</small>
          </div>
          <ResourceChart
            samples={scopedSamples}
            value={(sample, index, chartSamples) => {
              const previous = chartSamples[index - 1];
              if (!previous || sample.networkRxBytes === undefined || sample.networkTxBytes === undefined || previous.networkRxBytes === undefined || previous.networkTxBytes === undefined) return 0;
              const seconds = Math.max(1, (sample.sampledAt - previous.sampledAt) / 1000);
              return Math.max(0, ((sample.networkRxBytes - previous.networkRxBytes) + (sample.networkTxBytes - previous.networkTxBytes)) / seconds);
            }}
            tone="green"
            formatValue={formatRate}
            formatTime={formatTime}
            emptyLabel={hasStats ? "Collecting history" : statsUnavailableLabel}
          />
        </div>
      </div>
    </section>
  );
}
