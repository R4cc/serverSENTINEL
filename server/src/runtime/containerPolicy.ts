import { config } from "../config.js";
import { dockerJsonRequest } from "../docker/dockerClient.js";
import { isManagedContainerFor } from "./containerLabels.js";
import { minecraftTerminalContainerConfig } from "./terminal.js";

export function minecraftContainerCreateSettings(timeZone?: string) {
  const terminal = minecraftTerminalContainerConfig();
  return {
    OpenStdin: true,
    AttachStdin: true,
    // Applies to daemon-initiated stops too; creation fingerprints include this grace period.
    StopTimeout: config.minecraftStopTimeoutSeconds,
    ...terminal,
    ...(timeZone ? { Env: [...terminal.Env, `TZ=${timeZone}`] } : {})
  };
}

export async function reconcileContainerRestartPolicy(serverId: string, name: string, details: {
  Config?: { Labels?: Record<string, string> };
  HostConfig?: { RestartPolicy?: { Name?: string } };
}) {
  const previous = details.HostConfig?.RestartPolicy?.Name;
  if (!isManagedContainerFor(details.Config?.Labels, serverId) || !previous || previous === "no") return;
  await dockerJsonRequest("POST", `/containers/${encodeURIComponent(name)}/update`, { RestartPolicy: { Name: "no" } }, 200);
  details.HostConfig = { ...details.HostConfig, RestartPolicy: { Name: "no" } };
  return previous;
}
