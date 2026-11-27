import type { LogFields } from "../logging.js";
import { dockerContainerName } from "../storage/serverIdentity.js";
import type { ManagedServer } from "../types.js";

/**
 * The fields that identify a server in a log record. Lives apart from the Docker container module
 * so that routes, schedules and services can log about a server without importing the local
 * container runtime.
 */
export function serverLogFields(server: ManagedServer): LogFields {
  return {
    serverId: server.id,
    serverName: server.displayName,
    containerName: dockerContainerName(server)
  };
}
