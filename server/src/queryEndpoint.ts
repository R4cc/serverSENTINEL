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

export function resolveMinecraftQueryEndpoints(
  server: ManagedServer,
  props: Record<string, string> = {},
  minecraftInspect?: QueryNetworkInspect | null,
  callerInspect?: QueryNetworkInspect | null
): MinecraftQueryEndpoint[] {
  const diagnostics: string[] = [];
  const endpoints: MinecraftQueryEndpoint[] = [];
  const addEndpoint = (host: string | undefined, port: number | undefined, source: MinecraftQueryEndpoint["source"], detail: string) => {
    if (!host || !port || endpoints.some((candidate) => candidate.host === host && candidate.port === port)) return;
    endpoints.push({ host, port, source, diagnostics: [...diagnostics, detail] });
  };
  const internalPort = configuredQueryInternalPort(server, props);
  const externalPort = configuredQueryExternalPort(server, props);
  if (!internalPort && !externalPort) {
    return [];
  }

  const minecraftNetworks = minecraftInspect?.NetworkSettings?.Networks ?? {};
  const callerNetworks = callerInspect?.NetworkSettings?.Networks ?? {};
  for (const [name, network] of Object.entries(minecraftNetworks)) {
    const reachable = callerNetworks[name] || (network.NetworkID && Object.values(callerNetworks).some((candidate) => candidate.NetworkID === network.NetworkID));
    if (reachable && network.IPAddress && internalPort) {
      addEndpoint(network.IPAddress, internalPort, "container-network", `Using Minecraft container IP ${network.IPAddress} on shared Docker network ${name} with internal query port ${internalPort}.`);
    }
  }

  if (Object.keys(minecraftNetworks).length === 0) diagnostics.push("Minecraft container has no Docker network IPs in inspect data.");
  else if (Object.keys(callerNetworks).length === 0) {
    diagnostics.push("serverSENTINEL container network inspect data is unavailable; trying the Minecraft container network directly.");
    for (const [name, network] of Object.entries(minecraftNetworks)) {
      addEndpoint(network.IPAddress, internalPort, "container-network", `Trying Minecraft container IP ${network.IPAddress} on Docker network ${name} with internal query port ${internalPort}.`);
    }
  }
  else diagnostics.push("No shared Docker network with a Minecraft container IP was found.");

  if (externalPort) {
    for (const network of Object.values(callerNetworks)) {
      addEndpoint(network.Gateway, externalPort, "published-host", `Falling back to Docker host published UDP query port ${externalPort} via ${network.Gateway}.`);
    }
    for (const network of Object.values(minecraftNetworks)) {
      addEndpoint(network.Gateway, externalPort, "published-host", `Falling back to Docker host published UDP query port ${externalPort} via ${network.Gateway}.`);
    }
    if (Object.keys(callerNetworks).length === 0 && Object.keys(minecraftNetworks).length === 0) {
      addEndpoint("127.0.0.1", externalPort, "published-host", `Falling back to the locally published UDP query port ${externalPort}.`);
    }
  }
  return endpoints;
}
