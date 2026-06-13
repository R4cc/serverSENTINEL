import type { ManagedServer, ResourceSample, ServerStatus } from '../types';
import { parseMaxMemoryGb } from '../utils/format';

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

export function formatRate(bytesPerSecond?: number) {
  if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond)) return "Unavailable";
  if (bytesPerSecond < 1024) return `${Math.max(0, bytesPerSecond).toFixed(0)} B/s`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(0)} KB/s`;
  return `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s`;
}

function formatChartTime(sampledAt: number) {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(sampledAt));
}

export function Sparkline({
  samples,
  value,
  tone = "blue",
  emptyLabel = "No history yet",
  formatValue = (item) => item.toFixed(1)
}: {
  samples: ResourceSample[];
  value: (sample: ResourceSample, index: number, samples: ResourceSample[]) => number;
  tone?: "blue" | "green";
  emptyLabel?: string;
  formatValue?: (value: number) => string;
}) {
  const validSamples = samples.filter((sample) => sample.available && sample.running);
  const values = validSamples
    .map((sample, index) => ({ sample, value: value(sample, index, validSamples) }))
    .filter((item) => Number.isFinite(item.value));
  if (values.length < 2) return <div className="sparklineEmpty">{emptyLabel}</div>;

  const chart = { left: 42, right: 8, top: 10, bottom: 92, width: 240, height: 118 };
  const rawMax = Math.max(...values.map((item) => item.value), 1);
  const rawMin = Math.min(...values.map((item) => item.value), 0);
  const paddedMax = rawMax === rawMin ? rawMax + 1 : rawMax;
  const paddedMin = rawMax === rawMin ? Math.max(0, rawMin - 1) : rawMin;
  const range = Math.max(1, paddedMax - paddedMin);
  const plotWidth = chart.width - chart.left - chart.right;
  const plotHeight = chart.bottom - chart.top;
  const plotted = values.map((item, index) => {
    const x = chart.left + (values.length === 1 ? 0 : (index / (values.length - 1)) * plotWidth);
    const y = chart.bottom - ((item.value - paddedMin) / range) * plotHeight;
    return { ...item, x, y };
  });
  const points = plotted.map((item) => `${item.x.toFixed(2)},${item.y.toFixed(2)}`).join(" ");
  const firstSample = values[0].sample;
  const lastSample = values.at(-1)!.sample;
  const midValue = paddedMin + range / 2;

  return (
    <svg className={`sparkline resourceChart ${tone}`} viewBox={`0 0 ${chart.width} ${chart.height}`} preserveAspectRatio="none" role="img" aria-label="Resource usage history">
      <line className="chartAxis" x1={chart.left} y1={chart.top} x2={chart.left} y2={chart.bottom} />
      <line className="chartAxis" x1={chart.left} y1={chart.bottom} x2={chart.width - chart.right} y2={chart.bottom} />
      {[paddedMax, midValue, paddedMin].map((tick, index) => {
        const y = chart.top + (index / 2) * plotHeight;
        return (
          <g key={`${tick}-${index}`}>
            <line className="chartGridLine" x1={chart.left} y1={y} x2={chart.width - chart.right} y2={y} />
            <text className="chartTickLabel y" x={chart.left - 5} y={y + 3}>{formatValue(tick)}</text>
          </g>
        );
      })}
      <text className="chartTickLabel x" x={chart.left} y={chart.height - 8}>{formatChartTime(firstSample.sampledAt)}</text>
      <text className="chartTickLabel x end" x={chart.width - chart.right} y={chart.height - 8}>{formatChartTime(lastSample.sampledAt)}</text>
      <polyline points={points} />
      {plotted.map((item, index) => (
        <circle key={`${item.sample.sampledAt}-${index}`} className="chartPoint" cx={item.x} cy={item.y} r="6">
          <title>{`${formatChartTime(item.sample.sampledAt)} - ${formatValue(item.value)}`}</title>
        </circle>
      ))}
    </svg>
  );
}

export function ResourcePanel({
  server,
  samples,
  status,
  dockerSocketMounted,
  formatNumber
}: {
  server: ManagedServer;
  samples: ResourceSample[];
  status: ServerStatus | null;
  dockerSocketMounted: boolean;
  formatNumber: (value: number) => string;
}) {
  const latest = samples.at(-1);
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
      <div className="panelHeader">
        <h2>Resource Usage</h2>
      </div>
      <div className="resourceRows">
        <div className={`resourceRow ${hasStats ? "" : "unavailable"}`}>
          <div className="resourceMetricLabel">
            <span>Memory usage</span>
            <strong>{hasStats ? `${formatNumber(Math.round(memoryUsage / 1024 / 1024))} MB / ${formatNumber(Math.round(configuredMemoryBytes / 1024 / 1024))} MB` : statsUnavailableLabel}</strong>
            <small>{hasStats ? `${memoryPercent.toFixed(1)}%` : `Configured limit ${formatNumber(Math.round(configuredMemoryBytes / 1024 / 1024))} MB`}</small>
          </div>
          <Sparkline samples={samples} value={(sample) => sample.memoryUsageBytes / 1024 / 1024} formatValue={(value) => `${formatNumber(Math.round(value))} MB`} emptyLabel={hasStats ? "Collecting history" : statsUnavailableLabel} />
        </div>
        <div className={`resourceRow ${hasStats ? "" : "unavailable"}`}>
          <div className="resourceMetricLabel">
            <span>CPU usage</span>
            <strong>{hasStats ? `${cpu.toFixed(1)}%` : statsUnavailableLabel}</strong>
            <small>{hasStats ? "Current sample" : "Start the server to collect samples"}</small>
          </div>
          <Sparkline samples={samples} value={(sample) => sample.cpuPercent} formatValue={(value) => `${value.toFixed(1)}%`} emptyLabel={hasStats ? "Collecting history" : statsUnavailableLabel} />
        </div>
        <div className={`resourceRow ${hasStats ? "" : "unavailable"}`}>
          <div className="resourceMetricLabel">
            <span>Network activity</span>
            <strong>{networkValue}</strong>
            <small>{hasStats ? "Current transfer rate" : "Start the server to collect network activity"}</small>
          </div>
          <Sparkline
            samples={samples}
            value={(sample, index, chartSamples) => {
              const previous = chartSamples[index - 1];
              if (!previous || sample.networkRxBytes === undefined || sample.networkTxBytes === undefined || previous.networkRxBytes === undefined || previous.networkTxBytes === undefined) return 0;
              const seconds = Math.max(1, (sample.sampledAt - previous.sampledAt) / 1000);
              return Math.max(0, ((sample.networkRxBytes - previous.networkRxBytes) + (sample.networkTxBytes - previous.networkTxBytes)) / seconds);
            }}
            tone="green"
            formatValue={formatRate}
            emptyLabel={hasStats ? "Collecting history" : statsUnavailableLabel}
          />
        </div>
      </div>
    </section>
  );
}
