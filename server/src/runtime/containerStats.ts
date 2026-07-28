/**
 * Turns a Docker `/stats` sample into the resource numbers the panel reports.
 *
 * Shared by the panel's local Docker adapter and the node agent so a server reports the same figures
 * wherever it runs. The node agent previously skipped the page-cache subtraction and the CPU clamp,
 * so the same container read as several hundred MB heavier on a remote node, and could report a
 * negative CPU percentage after a restart reset the counters.
 */

export type DockerStatsSample = {
  read?: string;
  cpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number; online_cpus?: number };
  precpu_stats?: { cpu_usage?: { total_usage?: number }; system_cpu_usage?: number };
  memory_stats?: { usage?: number; limit?: number; stats?: { cache?: number; inactive_file?: number } };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
};

export type ContainerResourceSample = {
  cpuPercent: number;
  cpuCapacityCores: number;
  memoryUsageBytes: number;
  memoryLimitBytes: number;
  networkRxBytes: number;
  networkTxBytes: number;
  readAt: string;
};

export function computeContainerResourceSample(stats: DockerStatsSample): ContainerResourceSample {
  const cpuDelta = (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) - (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta = (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
  const cpuCapacityCores = stats.cpu_stats?.online_cpus || 1;
  // Both deltas must be positive: a container restart resets the counters and would otherwise yield
  // a negative percentage.
  const rawCpuPercent = systemDelta > 0 && cpuDelta > 0 ? (cpuDelta / systemDelta) * cpuCapacityCores * 100 : 0;

  const memoryUsage = stats.memory_stats?.usage ?? 0;
  // Docker counts reclaimable page cache in `usage`; excluding it reports what the process actually holds.
  const reclaimableCache = stats.memory_stats?.stats?.cache ?? stats.memory_stats?.stats?.inactive_file ?? 0;

  const networkTotals = Object.values(stats.networks ?? {}).reduce(
    (totals, network) => ({
      rx: totals.rx + (network.rx_bytes ?? 0),
      tx: totals.tx + (network.tx_bytes ?? 0)
    }),
    { rx: 0, tx: 0 }
  );

  return {
    cpuPercent: Number.isFinite(rawCpuPercent) ? Math.max(0, rawCpuPercent) : 0,
    cpuCapacityCores,
    memoryUsageBytes: Math.max(0, memoryUsage - reclaimableCache),
    memoryLimitBytes: stats.memory_stats?.limit ?? 0,
    networkRxBytes: networkTotals.rx,
    networkTxBytes: networkTotals.tx,
    readAt: stats.read ?? new Date().toISOString()
  };
}
