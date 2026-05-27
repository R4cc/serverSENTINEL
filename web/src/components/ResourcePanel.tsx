import type { ManagedServer, ResourceSample, ServerStatus } from '../types';
import { formatBytes, parseMaxMemoryGb } from '../utils/format';

export function formatUptime(startedAt?: string, running?: boolean) {
  if (!running || !startedAt || /^\d{2}:\d{2}:\d{2}$/.test(startedAt)) return "Unknown";
  const started = new Date(startedAt).getTime();
  if (!Number.isFinite(started)) return "Unknown";
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
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

export function Sparkline({ samples, value, tone = "blue" }: { samples: ResourceSample[]; value: (sample: ResourceSample) => number; tone?: "blue" | "green" }) {
  const values = samples.map(value).filter((item) => Number.isFinite(item));
  if (values.length < 2) return <div className="sparklineEmpty">No history yet</div>;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = Math.max(1, max - min);
  const points = values.map((item, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * 100;
    const y = 36 - ((item - min) / range) * 32 - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  return (
    <svg className={`sparkline ${tone}`} viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={points} />
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
  const cpu = latest?.cpuPercent ?? 0;
  const memoryUsage = latest?.memoryUsageBytes ?? 0;
  const configuredMemoryBytes = latest?.memoryLimitBytes || parseMaxMemoryGb(server.javaArgs) * 1024 * 1024 * 1024;
  const memoryPercent = configuredMemoryBytes ? (memoryUsage / configuredMemoryBytes) * 100 : 0;
  const previousNetworkSample = [...samples].reverse().find((sample) => sample !== latest && sample.networkRxBytes !== undefined && sample.networkTxBytes !== undefined);
  const secondsBetweenSamples = latest && previousNetworkSample ? Math.max(1, (latest.sampledAt - previousNetworkSample.sampledAt) / 1000) : undefined;
  const rxRate = latest?.networkRxBytes !== undefined && previousNetworkSample?.networkRxBytes !== undefined && secondsBetweenSamples
    ? Math.max(0, (latest.networkRxBytes - previousNetworkSample.networkRxBytes) / secondsBetweenSamples)
    : undefined;
  const txRate = latest?.networkTxBytes !== undefined && previousNetworkSample?.networkTxBytes !== undefined && secondsBetweenSamples
    ? Math.max(0, (latest.networkTxBytes - previousNetworkSample.networkTxBytes) / secondsBetweenSamples)
    : undefined;
  const statusMessage = latest?.message
    || (!dockerSocketMounted
      ? "Docker socket is not mounted, so live container stats are unavailable."
      : status?.docker.running
        ? "Collecting Docker stats."
        : status?.docker.message || "Start the container to collect live stats.");

  return (
    <section className="panel resourcePanel">
      <div className="panelHeader">
        <h2>Resource Usage</h2>
      </div>
      <div className="resourceRows">
        <div className="resourceRow">
          <div className="resourceMetricLabel">
            <span>Memory usage</span>
            <strong>{`${formatNumber(Math.round(memoryUsage / 1024 / 1024))} MB`} / {`${formatNumber(Math.round(configuredMemoryBytes / 1024 / 1024))} MB`}</strong>
            <small>{memoryPercent.toFixed(1)}%</small>
          </div>
          <Sparkline samples={samples} value={(sample) => sample.memoryUsageBytes} />
        </div>
        <div className="resourceRow">
          <div className="resourceMetricLabel">
            <span>CPU usage</span>
            <strong>{cpu.toFixed(1)}%</strong>
            <small>Average</small>
          </div>
          <Sparkline samples={samples} value={(sample) => sample.cpuPercent} />
        </div>
        <div className="resourceRow">
          <div className="resourceMetricLabel">
            <span>Network activity</span>
            <strong>{`↑ ${formatRate(txRate)} / ↓ ${formatRate(rxRate)}`}</strong>
            <small>Current transfer rate</small>
          </div>
          <Sparkline samples={samples} value={(sample) => sample.networkRxBytes ?? 0} tone="green" />
        </div>
      </div>
      {!latest?.available && <p className="resourceMessage">{statusMessage}</p>}
    </section>
  );
}
