import { runtimeForServer, services } from "../appServices.js";
import { maxServerPort, minServerPort } from "../config.js";
import { allocateQueryPort, assertNodePortsAvailable, assertUniqueDockerHostPorts, dockerPortsWithManagedEntries, isValidServerPort, normalizeManagedPorts, queryPortEntry, type CreateServerInput } from "./ports.js";
import { listManagedServers } from "./store.js";
import type { ManagedServer } from "../types.js";

export type ServerSettingsUpdateInput = {
  displayName?: string;
  runtime?: CreateServerInput["runtime"];
  dockerContainer?: string;
  dockerImage?: string;
  dockerPorts?: string;
  queryPort?: string;
  javaArgs?: string;
  serverPort?: string;
  startOnNodeStart?: boolean;
};

/**
 * Applies a settings change to a stopped server: validates the name and ports against the whole
 * fleet, then hands the runtime change to the server's node. Callers hold the server's mutation
 * lock and have already checked that it is stopped.
 */
export async function applyServerSettingsUpdate(server: ManagedServer, input: ServerSettingsUpdateInput) {
  const nextDisplayName = input.displayName?.trim() || server.displayName;
  const servers = await listManagedServers();
  if (servers.some((candidate) => candidate.id !== server.id && candidate.displayName.toLowerCase() === nextDisplayName.toLowerCase())) {
    throw new Error("A managed server with this display name already exists");
  }
  const serverPort = input.serverPort?.trim();
  if (serverPort && !isValidServerPort(serverPort)) {
    throw new Error(`Server port must be between ${minServerPort} and ${maxServerPort}`);
  }
  const requestedDockerPorts = input.dockerPorts?.trim() || (serverPort ? `${serverPort}:${serverPort}/tcp` : server.dockerPorts);
  const currentQueryPort = server.managedPorts?.find((port) => port.type === "query")?.externalPort;
  const queryPort = input.queryPort?.trim() || (currentQueryPort ? String(currentQueryPort) : undefined);
  const allocatedQueryPort = allocateQueryPort(servers, server.nodeId, requestedDockerPorts || "", queryPort, { ignoreServerId: server.id });
  const managedPorts = normalizeManagedPorts(requestedDockerPorts || "", [queryPortEntry(allocatedQueryPort)]);
  const dockerPorts = dockerPortsWithManagedEntries(requestedDockerPorts || "", managedPorts);
  if (dockerPorts) {
    assertUniqueDockerHostPorts(dockerPorts);
    assertNodePortsAvailable(servers, server.nodeId, dockerPorts, { ignoreServerId: server.id });
  }
  return services.exportCoordinator.withMutation(server.id, () => runtimeForServer(server).updateServer(server, { ...input, dockerPorts, queryPort: String(allocatedQueryPort) }));
}
