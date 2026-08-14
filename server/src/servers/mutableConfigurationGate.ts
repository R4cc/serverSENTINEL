import type { OperationType } from "../types.js";

/**
 * The "server must be stopped" gate, shared by the panel and the node agent.
 *
 * This lives apart from `lifecycle.ts` because the node agent runs without `appServices`; keeping the
 * decision pure means both sides answer identically instead of drifting.
 */

export const stoppedServerMutationMessage = "Stop the server before changing mods, plugins, or server properties.";
export const blockingRuntimeOperationTypes = new Set<OperationType>(["server.start", "server.stop", "server.restart"]);
const stoppedLikeDockerStates = new Set(["created", "dead", "exited"]);

type DockerStatusShape = {
  configured?: unknown;
  available?: unknown;
  running?: unknown;
  state?: unknown;
  message?: unknown;
};

/** A container the panel knows about but that no longer exists must not block config edits. */
const absentContainerMessage = /container (?:will be created|not found|does not exist)|configured container does not exist/i;

/** Returns the reason mutable configuration is blocked, or `""` when the edit is allowed. */
export function mutableServerConfigurationBlockedReason(status: unknown, operations: Array<{ type?: string }> = []) {
  if (operations.some((operation) => blockingRuntimeOperationTypes.has(operation.type as OperationType))) {
    return stoppedServerMutationMessage;
  }
  const docker = status && typeof status === "object" && "docker" in status
    ? (status as { docker?: DockerStatusShape }).docker
    : status as DockerStatusShape | undefined;
  if (docker?.running === true) return stoppedServerMutationMessage;
  const state = typeof docker?.state === "string" ? docker.state : "";
  const message = typeof docker?.message === "string" ? docker.message : "";
  if (state === "unknown") {
    return docker?.configured === false || (docker?.available === true && absentContainerMessage.test(message))
      ? ""
      : stoppedServerMutationMessage;
  }
  if (state && !stoppedLikeDockerStates.has(state)) return stoppedServerMutationMessage;
  return "";
}
