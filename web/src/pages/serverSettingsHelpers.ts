import type { ContextNode, FabricVersions, ManagedServer, RuntimeLoaderVersion } from "../types";
import {
  defaultQueryPort,
  defaultServerPort,
  isValidServerPort,
  maxServerPort,
  minServerPort,
  totalMemoryGb
} from "../utils/format";

export type PortBindingRow = {
  id: string;
  hostPort: string;
  target: string;
};

export type CreateWizardPortBinding = {
  id: string;
  containerPort: string;
  protocol: "tcp" | "udp";
  hostPort: string;
  description: string;
};

export type CreateWizardMinecraftVersion = FabricVersions["game"][number];

export type MemoryBounds = {
  min: number;
  max: number;
  recommendedMin: number;
  recommendedMax: number;
};

const fallbackMinecraftVersions = [
  { version: "1.21.6", stable: true },
  { version: "1.21.4", stable: true },
  { version: "1.21.1", stable: true },
  { version: "1.20.6", stable: true },
  { version: "1.20.1", stable: true },
  { version: "1.19.4", stable: true },
  { version: "1.19.2", stable: true },
  { version: "1.18.2", stable: true },
  { version: "1.18", stable: true }
];

export const fallbackFabricLoaderVersions: RuntimeLoaderVersion[] = [
  { id: "0.16.14", loaderVersion: "0.16.14", stable: true, recommended: true },
  { id: "0.16.13", loaderVersion: "0.16.13", stable: true },
  { id: "0.16.10", loaderVersion: "0.16.10", stable: true }
];

export function portBindingId() {
  return `port-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function normalizeDefaultPort(value: string) {
  return isValidServerPort(value) ? value : String(defaultServerPort);
}

function normalizeQueryPort(value: string) {
  return isValidServerPort(value) ? value : String(defaultQueryPort);
}

function parsePortBinding(binding: string): PortBindingRow {
  const pieces = binding.split(":");
  const hostPort = pieces.length === 2 ? pieces[0].trim() : pieces[0].split("/", 1)[0].trim();
  const target = pieces.length === 2 ? pieces[1].trim() : pieces[0].trim();
  return {
    id: portBindingId(),
    hostPort,
    target: target.includes("/") ? target : `${target}/tcp`
  };
}

function parsePortBindings(value: string | undefined): PortBindingRow[] {
  return (value || "")
    .split(",")
    .map((rawBinding) => rawBinding.trim())
    .filter(Boolean)
    .map(parsePortBinding);
}

function parseDockerBindingPorts(value?: string) {
  const rows = parsePortBindings(value);
  const serverBinding = rows.find((row) => {
    const [containerPort, protocol = "tcp"] = row.target.split("/", 2);
    return protocol === "tcp" && (containerPort === row.hostPort || containerPort === String(defaultServerPort));
  });
  const queryBinding = rows.find((row) => {
    const [containerPort, protocol = "tcp"] = row.target.split("/", 2);
    return protocol === "udp" && (containerPort === row.hostPort || containerPort === String(defaultQueryPort));
  });
  return {
    serverPort: serverBinding?.hostPort && isValidServerPort(serverBinding.hostPort) ? serverBinding.hostPort : String(defaultServerPort),
    queryPort: queryBinding?.hostPort && isValidServerPort(queryBinding.hostPort) ? queryBinding.hostPort : String(defaultQueryPort)
  };
}

export function queryPortForServer(server: ManagedServer) {
  const managed = server.managedPorts?.find((port) => port.type === "query")?.externalPort;
  if (managed && isValidServerPort(String(managed))) return String(managed);
  return parseDockerBindingPorts(server.dockerPorts).queryPort;
}

export function serverPortForServer(server: ManagedServer) {
  return parseDockerBindingPorts(server.dockerPorts).serverPort;
}

export function parseAdditionalPortBindings(value: string | undefined, serverPort: string, queryPort: string): PortBindingRow[] {
  const normalizedServerPort = normalizeDefaultPort(serverPort);
  const normalizedQueryPort = normalizeQueryPort(queryPort);
  return parsePortBindings(value).filter((row) => {
    const [containerPort, protocol = "tcp"] = row.target.split("/", 2);
    const isServerPort = row.hostPort === normalizedServerPort && containerPort === normalizedServerPort && protocol === "tcp";
    const isQueryPort = row.hostPort === normalizedQueryPort && containerPort === normalizedQueryPort && protocol === "udp";
    return !isServerPort && !isQueryPort;
  });
}

function formatAdditionalPortBindings(rows: PortBindingRow[]) {
  return rows
    .map((row) => ({ hostPort: row.hostPort.trim(), target: row.target.trim() }))
    .filter((row) => row.hostPort || row.target)
    .map((row) => `${row.hostPort}:${row.target}`)
    .join(",");
}

export function formatManagedPortBindings(serverPort: string, queryPort: string, additionalRows: PortBindingRow[]) {
  const normalizedServerPort = normalizeDefaultPort(serverPort);
  const normalizedQueryPort = normalizeQueryPort(queryPort);
  return [
    `${normalizedServerPort}:${normalizedServerPort}/tcp`,
    `${normalizedQueryPort}:${normalizedQueryPort}/udp`,
    formatAdditionalPortBindings(additionalRows)
  ].filter(Boolean).join(",");
}

export function runtimeMinecraftOptions(versions: FabricVersions, showSnapshots: boolean): CreateWizardMinecraftVersion[] {
  const source: CreateWizardMinecraftVersion[] = versions.game.length > 0 ? versions.game : fallbackMinecraftVersions;
  const filtered = showSnapshots ? source : source.filter((version) => version.type === undefined || version.type === "release");
  return filtered.length > 0 ? filtered : source;
}

export function preferredMinecraftVersion(options: CreateWizardMinecraftVersion[]) {
  return options.find((version) => version.version === "1.21.6")?.version
    || options.find((version) => version.type === undefined || version.type === "release")?.version
    || options[0]?.version
    || "1.21.6";
}

export function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

export function memoryBoundsForNode(totalMemory: number): MemoryBounds {
  const max = totalMemoryGb(totalMemory);
  return {
    min: 1,
    max,
    recommendedMin: Math.min(2, max),
    recommendedMax: Math.min(Math.max(2, max), 8)
  };
}

export function makeCreatePortBinding(partial: Partial<CreateWizardPortBinding> = {}): CreateWizardPortBinding {
  return {
    id: portBindingId(),
    containerPort: partial.containerPort ?? "",
    protocol: partial.protocol ?? "tcp",
    hostPort: partial.hostPort ?? "",
    description: partial.description ?? ""
  };
}

export function wizardDockerPorts(serverPort: string, additionalBindings: CreateWizardPortBinding[]) {
  return [
    `${serverPort}:${serverPort}/tcp`,
    ...additionalBindings
      .filter((binding) => binding.hostPort.trim() && binding.containerPort.trim())
      .map((binding) => `${binding.hostPort.trim()}:${binding.containerPort.trim()}/${binding.protocol}`)
  ].join(",");
}

function serverUsedPortKeys(server: ManagedServer) {
  const keys = new Set<string>();
  for (const row of parsePortBindings(server.dockerPorts)) {
    const protocol = row.target.split("/", 2)[1] || "tcp";
    if (row.hostPort && (protocol === "tcp" || protocol === "udp")) {
      keys.add(`${row.hostPort}/${protocol}`);
    }
  }
  for (const port of server.managedPorts || []) {
    keys.add(`${port.externalPort}/${port.protocol}`);
  }
  return keys;
}

export function usedPortKeysForNode(node: ContextNode | undefined) {
  const keys = new Set<string>();
  for (const server of node?.servers || []) {
    for (const key of serverUsedPortKeys(server)) keys.add(key);
  }
  return keys;
}

export function findAvailablePort(usedKeys: Set<string>, protocol: "tcp" | "udp", preferred: number, avoidPorts: Set<string> = new Set()) {
  for (let port = preferred; port <= maxServerPort; port += 1) {
    const value = String(port);
    if (!avoidPorts.has(value) && !usedKeys.has(`${value}/${protocol}`)) return value;
  }
  for (let port = minServerPort; port < preferred; port += 1) {
    const value = String(port);
    if (!avoidPorts.has(value) && !usedKeys.has(`${value}/${protocol}`)) return value;
  }
  return String(preferred);
}

export function wizardJavaArgs(minimumHeapGb: number, maximumHeapGb: number, currentArgs = "") {
  const withoutMemory = currentArgs
    .replace(/(^|\s)-Xms\S+/g, "")
    .replace(/(^|\s)-Xmx\S+/g, "")
    .trim();
  return [`-Xms${minimumHeapGb}G`, `-Xmx${maximumHeapGb}G`, withoutMemory].filter(Boolean).join(" ");
}

export function nodeDisplayName(node: ContextNode | undefined) {
  if (!node) return "No node selected";
  return node.isInternal ? "Internal Node" : node.name;
}

export function nodeStatusTextLabel(node: ContextNode | undefined) {
  if (!node) return "Not selected";
  return nodeStatusText(node);
}

export function nodeStatusText(node: ContextNode) {
  if (node.status === "online") return "Online";
  if (node.status === "offline") return "Offline";
  return "Unknown";
}

export function formatNodeUptime(node: ContextNode) {
  if (node.status !== "online") return "Unavailable";
  const since = node.connectedAt || node.lastSeenAt || node.updatedAt || node.createdAt;
  if (!since) return "Unknown";
  const elapsedMs = Date.now() - new Date(since).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "Unknown";
  const totalMinutes = Math.max(0, Math.floor(elapsedMs / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
