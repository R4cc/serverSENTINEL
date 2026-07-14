import type { ManagedNode } from "../../types";
import { formatBytes } from "../../utils/format";

export type SettingsSystemInfo = {
  panelVersion: string;
  buildId?: string;
  runtimeMode?: "all-in-one" | "panel" | "node";
  panelTimeZone: string;
  displayTimeZone: string;
  dockerSocketMounted: boolean;
  panelOnlyMode: boolean;
  demoMode: boolean;
  serverCount: number;
  nodes: ManagedNode[];
  totalMemory: number;
  modrinthConfigured: boolean;
};

export type SettingsSystemSummary = {
  nodeCount: number;
  onlineNodeCount: number;
  compatibleNodeCount: number;
  incompatibleNodeCount: number;
  unknownCompatibilityCount: number;
  agentVersions: string;
  protocolVersions: string;
  dockerStatus: string;
  memory: string;
};

function aggregateVersions(nodes: ManagedNode[], field: "agentVersion" | "protocolVersion") {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const value = node[field]?.trim() || "Unknown";
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  if (counts.size === 0) return "None";
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([value, count]) => `${value} (${count})`)
    .join(", ");
}

export function summarizeSettingsSystemInfo(info: SettingsSystemInfo): SettingsSystemSummary {
  return {
    nodeCount: info.nodes.length,
    onlineNodeCount: info.nodes.filter((node) => node.status === "online").length,
    compatibleNodeCount: info.nodes.filter((node) => node.compatibility === "compatible").length,
    incompatibleNodeCount: info.nodes.filter((node) => node.compatibility === "incompatible").length,
    unknownCompatibilityCount: info.nodes.filter((node) => !node.compatibility || node.compatibility === "unknown").length,
    agentVersions: aggregateVersions(info.nodes, "agentVersion"),
    protocolVersions: aggregateVersions(info.nodes, "protocolVersion"),
    dockerStatus: info.panelOnlyMode
      ? "Not required (remote-node mode)"
      : info.demoMode
        ? "Demo override"
        : info.dockerSocketMounted
          ? "Connected"
          : "Not mounted",
    memory: info.totalMemory > 0 ? formatBytes(info.totalMemory) : "Unknown"
  };
}

export function buildSystemDiagnostics(info: SettingsSystemInfo, generatedAt = new Date()) {
  const summary = summarizeSettingsSystemInfo(info);
  return [
    "serverSENTINEL diagnostics",
    `Generated: ${generatedAt.toISOString()}`,
    `Panel version: ${info.panelVersion || "Unknown"}`,
    `Panel build: ${info.buildId || "Unknown"}`,
    `Runtime mode: ${info.runtimeMode || "Unknown"}`,
    `Panel time zone: ${info.panelTimeZone}`,
    `Display time zone: ${info.displayTimeZone}`,
    `Docker control: ${summary.dockerStatus}`,
    `Managed servers: ${info.serverCount}`,
    `Nodes online: ${summary.onlineNodeCount}/${summary.nodeCount}`,
    `Node compatibility: ${summary.compatibleNodeCount} compatible, ${summary.incompatibleNodeCount} incompatible, ${summary.unknownCompatibilityCount} unknown`,
    `Agent versions: ${summary.agentVersions}`,
    `Protocol versions: ${summary.protocolVersions}`,
    `Detected memory: ${summary.memory}`,
    `Modrinth integration: ${info.modrinthConfigured ? "Configured" : "Not configured"}`
  ].join("\n");
}
