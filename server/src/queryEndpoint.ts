import type { ManagedServer } from "./types.js";

export type QueryNetworkInspect = {
  Id?: string;
  Name?: string;
  NetworkSettings?: {
    Networks?: Record<string, { NetworkID?: string; IPAddress?: string; Gateway?: string }>;
  };
};

export type MinecraftQueryEndpoint = {
  host: string;
  port: number;
  source: "container-network" | "published-host";
  diagnostics: string[];
};

export function minecraftQueryDisabled(props: Record<string, string> = {}) {
  return props["enable-query"]?.trim().toLowerCase() !== "true";
}

export function queryPortBinding(server: ManagedServer) {
  return server.managedPorts?.find((port) => port.type === "query" && port.protocol === "udp");
}

export function configuredQueryInternalPort(server: ManagedServer, props: Record<string, string> = {}) {
  const stored = queryPortBinding(server)?.internalPort;
  if (stored) return stored;
  const prop = props["query.port"] ? Number(props["query.port"]) : null;
  return prop && Number.isFinite(prop) ? prop : undefined;
}

export function configuredQueryExternalPort(server: ManagedServer, props: Record<string, string> = {}) {
  const stored = queryPortBinding(server)?.externalPort;
  if (stored) return stored;
  const prop = props["query.port"] ? Number(props["query.port"]) : null;
  return prop && Number.isFinite(prop) ? prop : undefined;
}

export function resolveMinecraftQueryEndpoint(
  server: ManagedServer,
  props: Record<string, string> = {},
  minecraftInspect?: QueryNetworkInspect | null,
  callerInspect?: QueryNetworkInspect | null
): MinecraftQueryEndpoint | null {
  const diagnostics: string[] = [];
  const internalPort = configuredQueryInternalPort(server, props);
  const externalPort = configuredQueryExternalPort(server, props);
  if (!internalPort && !externalPort) {
    diagnostics.push("No Minecraft Query UDP port is configured.");
    return null;
  }

  const minecraftNetworks = minecraftInspect?.NetworkSettings?.Networks ?? {};
  const callerNetworks = callerInspect?.NetworkSettings?.Networks ?? {};
  for (const [name, network] of Object.entries(minecraftNetworks)) {
    const reachable = callerNetworks[name] || (network.NetworkID && Object.values(callerNetworks).some((candidate) => candidate.NetworkID === network.NetworkID));
    if (reachable && network.IPAddress && internalPort) {
      diagnostics.push(`Using Minecraft container IP ${network.IPAddress} on shared Docker network ${name} with internal query port ${internalPort}.`);
      return { host: network.IPAddress, port: internalPort, source: "container-network", diagnostics };
    }
  }

  if (Object.keys(minecraftNetworks).length === 0) diagnostics.push("Minecraft container has no Docker network IPs in inspect data.");
  else if (Object.keys(callerNetworks).length === 0) diagnostics.push("serverSENTINEL container network inspect data is unavailable; cannot find a shared Docker network.");
  else diagnostics.push("No shared Docker network with a Minecraft container IP was found.");

  if (externalPort) {
    const gateway = Object.values(callerNetworks).find((network) => network.Gateway)?.Gateway;
    const host = gateway || "127.0.0.1";
    diagnostics.push(`Falling back to Docker host published UDP query port ${externalPort} via ${host}.`);
    return { host, port: externalPort, source: "published-host", diagnostics };
  }
  return null;
}
