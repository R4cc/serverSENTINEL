import { maxServerPort, minServerPort } from "../config.js";

import { dockerHostPortBindings, parseDockerPorts, type DockerHostPortBinding } from "../core.js";
import { localNodeId } from "../nodes/nodeService.js";
import type { ManagedServer, ManagedServerPort, ServerRuntimeIssue } from "../types.js";

export type CreateServerInput = {
  nodeId?: string;
  displayName?: string;
  runtime?: {
    runtimeType?: string;
    runtimeVersion?: string;
    minecraftVersion?: string;
    serverJar?: string;
  };
  dockerContainer?: string;
  dockerImage?: string;
  dockerPorts?: string;
  queryPort?: string;
  javaArgs?: string;
  acceptEula?: boolean;
  serverPort?: string;
};

export type ProvisionPortReservation = {
  nodeId: string;
  dockerPorts: string;
  displayName: string;
};
export const activeProvisionPortReservations = new Map<string, ProvisionPortReservation>();

export function isValidServerPort(port: string) {
  if (!/^\d+$/.test(port)) return false;
  const value = Number(port);
  return value >= minServerPort && value <= maxServerPort;
}

export const defaultQueryPort = 25566;

export function assertUniqueDockerHostPorts(dockerPorts: string) {
  const seen = new Map<string, DockerHostPortBinding>();
  for (const port of dockerHostPortBindings(dockerPorts)) {
    const existing = seen.get(port.key);
    if (existing) {
      throw new Error(`Port ${existing.port}/${existing.protocol} is listed more than once. Each Docker host port can only be used once per server.`);
    }
    seen.set(port.key, port);
  }
}

export function parsePortNumber(value: string, field: string) {
  if (!isValidServerPort(value)) {
    throw new Error(`${field} must be between ${minServerPort} and ${maxServerPort}`);
  }
  return Number(value);
}

export function queryPortEntry(port: number, internalPort = port): ManagedServerPort {
  return {
    id: "minecraft-query",
    name: "Minecraft Query",
    type: "query",
    protocol: "udp",
    internalPort,
    externalPort: port,
    required: true,
    removable: false,
    advanced: true
  };
}

export function portEntryBinding(port: ManagedServerPort) {
  return `${port.externalPort}:${port.internalPort}/${port.protocol}`;
}

export function managedPortsForDockerPorts(dockerPorts: string, existing: ManagedServerPort[] = []) {
  const queryPort = existing.find((port) => port.type === "query")?.externalPort;
  const seen = new Set<string>();
  const ports: ManagedServerPort[] = [];
  const { portBindings } = parseDockerPorts(dockerPorts);
  for (const [containerPort, bindings] of Object.entries(portBindings)) {
    const [internalPortValue, protocol = "tcp"] = containerPort.split("/", 2);
    for (const binding of bindings) {
      const externalPort = Number(binding.HostPort);
      const internalPort = Number(internalPortValue);
      const key = `${externalPort}/${protocol}`;
      const existingEntry = existing.find((port) => `${port.externalPort}/${port.protocol}` === key);
      const type = existingEntry?.type ?? (protocol === "tcp" && ports.length === 0 ? "minecraft" : "custom");
      if (seen.has(key)) continue;
      seen.add(key);
      ports.push(existingEntry ?? {
        id: type === "minecraft" ? "minecraft-server" : `custom-${key}`,
        name: type === "minecraft" ? "Minecraft Server" : `Port ${externalPort}/${protocol}`,
        type,
        protocol: protocol as "tcp" | "udp",
        internalPort,
        externalPort,
        required: type !== "custom",
        removable: type === "custom",
        advanced: type !== "minecraft"
      });
    }
  }
  if (queryPort && !ports.some((port) => port.type === "query")) {
    ports.push(queryPortEntry(queryPort));
  }
  return ports;
}

export function normalizeManagedPorts(dockerPorts: string, managedPorts: ManagedServerPort[] = []) {
  const ports = managedPortsForDockerPorts(dockerPorts, managedPorts);
  const query = ports.find((port) => port.type === "query");
  return query ? ports.map((port) => port.type === "query" ? queryPortEntry(query.externalPort, query.internalPort) : port) : ports;
}

export function dockerPortsWithManagedEntries(dockerPorts: string, managedPorts: ManagedServerPort[]) {
  const bindings = new Map<string, string>();
  for (const rawPort of dockerPorts.split(",")) {
    const rawBinding = rawPort.trim();
    if (!rawBinding) continue;
    const [hostPort, containerPortWithProtocol] = rawBinding.includes(":") ? rawBinding.split(":", 2) : [rawBinding, rawBinding];
    const [, protocol = "tcp"] = containerPortWithProtocol.split("/", 2);
    bindings.set(`${hostPort}/${protocol}`, rawBinding.includes("/") ? rawBinding : `${hostPort}:${containerPortWithProtocol}/tcp`);
  }
  for (const port of managedPorts) {
    bindings.set(`${port.externalPort}/${port.protocol}`, portEntryBinding(port));
  }
  return [...bindings.values()].join(",");
}

export function usedPortKeysForNode(servers: ManagedServer[], nodeId: string, ignoreServerId?: string) {
  const used = new Set<string>();
  for (const server of servers) {
    if (server.nodeId !== nodeId || server.id === ignoreServerId) continue;
    for (const port of dockerHostPortBindings(server.dockerPorts || "25565:25565/tcp")) {
      used.add(port.key);
    }
    for (const port of server.managedPorts ?? []) {
      used.add(`${port.externalPort}/${port.protocol}`);
    }
  }
  return used;
}

export function usedProvisionPortKeys(nodeId: string, ignoreJobId?: string) {
  const used = new Set<string>();
  for (const [jobId, reservation] of activeProvisionPortReservations) {
    if (jobId === ignoreJobId || reservation.nodeId !== nodeId) continue;
    for (const port of dockerHostPortBindings(reservation.dockerPorts)) {
      used.add(port.key);
    }
  }
  return used;
}

export function allocateQueryPort(servers: ManagedServer[], nodeId: string, dockerPorts: string, explicitQueryPort?: string, options: { ignoreServerId?: string; ignoreJobId?: string } = {}) {
  const requestedKeys = new Set(dockerHostPortBindings(dockerPorts).map((port) => port.key));
  const used = usedPortKeysForNode(servers, nodeId, options.ignoreServerId);
  for (const key of usedProvisionPortKeys(nodeId, options.ignoreJobId)) used.add(key);
  if (explicitQueryPort?.trim()) {
    const port = parsePortNumber(explicitQueryPort.trim(), "Query port");
    const key = `${port}/udp`;
    if (used.has(key) || requestedKeys.has(`${port}/tcp`)) {
      throw new Error(`Port ${port}/udp is already used on this node. Choose a different Minecraft Query port.`);
    }
    return port;
  }
  for (let port = defaultQueryPort; port <= maxServerPort; port += 1) {
    const udpKey = `${port}/udp`;
    const tcpKey = `${port}/tcp`;
    if (!used.has(udpKey) && !used.has(tcpKey) && !requestedKeys.has(udpKey) && !requestedKeys.has(tcpKey)) {
      return port;
    }
  }
  throw new Error("No free Minecraft Query port is available on this node.");
}

export function normalizeCreateServerPorts(input: CreateServerInput, servers: ManagedServer[] = [], nodeId = localNodeId, options: { ignoreServerId?: string; ignoreJobId?: string } = {}) {
  const serverPort = input.serverPort?.trim() || "25565";
  if (!isValidServerPort(serverPort)) {
    throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
  }
  const dockerPorts = input.dockerPorts?.trim() || `${serverPort}:${serverPort}/tcp`;
  assertUniqueDockerHostPorts(dockerPorts);
  const queryPort = allocateQueryPort(servers, nodeId, dockerPorts, input.queryPort, options);
  const managedPorts = normalizeManagedPorts(dockerPorts, [queryPortEntry(queryPort)]);
  const completeDockerPorts = dockerPortsWithManagedEntries(dockerPorts, managedPorts);
  assertUniqueDockerHostPorts(completeDockerPorts);
  return { serverPort, dockerPorts: completeDockerPorts, queryPort, managedPorts };
}

export function portConflictMessage(port: DockerHostPortBinding, ownerName: string) {
  return `Port ${port.port}/${port.protocol} is already used on this node by ${ownerName}. Choose a different server port or Docker port binding.`;
}

export function findExistingServerPortConflict(
  servers: ManagedServer[],
  nodeId: string,
  dockerPorts: string,
  ignoreServerId?: string
) {
  const requestedPorts = dockerHostPortBindings(dockerPorts);
  const requestedKeys = new Set(requestedPorts.map((port) => port.key));
  for (const server of servers) {
    if (server.nodeId !== nodeId || server.id === ignoreServerId) continue;
    for (const port of dockerHostPortBindings(server.dockerPorts || "25565:25565/tcp")) {
      if (requestedKeys.has(port.key)) {
        return {
          port,
          ownerId: server.id,
          ownerDisplayName: server.displayName,
          ownerName: `managed server "${server.displayName}"`
        };
      }
    }
  }
  return null;
}

export function unresolvedServerPortIssues(server: ManagedServer, servers: ManagedServer[]): ServerRuntimeIssue[] {
  if (!server.portConflictUnresolved) return [];
  const issues = new Map<string, ServerRuntimeIssue>();
  const requested = dockerHostPortBindings(server.dockerPorts || "25565:25565/tcp");
  for (const candidate of servers) {
    if (candidate.id === server.id || candidate.nodeId !== server.nodeId) continue;
    const candidateKeys = new Set(dockerHostPortBindings(candidate.dockerPorts || "25565:25565/tcp").map((port) => port.key));
    for (const port of requested) {
      if (!candidateKeys.has(port.key)) continue;
      const key = `${port.key}:${candidate.id}`;
      issues.set(key, {
        code: "port_conflict",
        message: `Port ${port.port}/${port.protocol} is also assigned to ${candidate.displayName}.`,
        port: Number(port.port),
        protocol: port.protocol === "udp" ? "udp" : "tcp",
        conflictingServerId: candidate.id,
        conflictingServerName: candidate.displayName
      });
    }
  }
  return [...issues.values()];
}

export function findProvisionPortConflict(nodeId: string, dockerPorts: string, ignoreJobId?: string) {
  const requestedPorts = dockerHostPortBindings(dockerPorts);
  const requestedKeys = new Set(requestedPorts.map((port) => port.key));
  for (const [jobId, reservation] of activeProvisionPortReservations) {
    if (jobId === ignoreJobId || reservation.nodeId !== nodeId) continue;
    for (const port of dockerHostPortBindings(reservation.dockerPorts)) {
      if (requestedKeys.has(port.key)) {
        return {
          port,
          ownerName: `provisioning job for "${reservation.displayName}"`
        };
      }
    }
  }
  return null;
}

export function assertNodePortsAvailable(servers: ManagedServer[], nodeId: string, dockerPorts: string, options: { ignoreServerId?: string; ignoreJobId?: string } = {}) {
  const existingConflict = findExistingServerPortConflict(servers, nodeId, dockerPorts, options.ignoreServerId);
  if (existingConflict) {
    throw new Error(portConflictMessage(existingConflict.port, existingConflict.ownerName));
  }
  const provisionConflict = findProvisionPortConflict(nodeId, dockerPorts, options.ignoreJobId);
  if (provisionConflict) {
    throw new Error(portConflictMessage(provisionConflict.port, provisionConflict.ownerName));
  }
}

