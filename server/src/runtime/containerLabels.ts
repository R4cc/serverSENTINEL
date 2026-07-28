/**
 * Labels stamped on managed Minecraft containers, shared by the panel's local Docker adapter and the
 * node agent.
 *
 * These two adapters used to spell the server-id label differently (`serversentinel.server-id` vs
 * `serversentinel.serverId`). The panel never read its own copy so nothing broke in practice, but a
 * node agent inspecting a panel-created container on the same Docker host would fail its ownership
 * check and refuse to control the container. Keep both sides on these constants.
 */

export const managedLabel = "serversentinel.managed";
export const serverIdLabel = "serversentinel.server-id";
export const configHashLabel = "serversentinel.config-hash";

/**
 * The node agent wrote this spelling before the keys were unified. Containers outlive a panel
 * upgrade, so ownership checks still accept it; nothing writes it any more.
 */
export const legacyServerIdLabel = "serversentinel.serverId";

export type ContainerLabels = Record<string, string> | undefined;

export function managedContainerLabels(serverId: string, configHash: string): Record<string, string> {
  return {
    [managedLabel]: "true",
    [serverIdLabel]: serverId,
    [configHashLabel]: configHash
  };
}

/** True when the container carries the managed marker, regardless of which server owns it. */
export function isManagedContainer(labels: ContainerLabels) {
  return labels?.[managedLabel] === "true";
}

/** True when the container is managed *and* belongs to this server, accepting the legacy spelling. */
export function isManagedContainerFor(labels: ContainerLabels, serverId: string) {
  if (!isManagedContainer(labels)) return false;
  const owner = labels?.[serverIdLabel] ?? labels?.[legacyServerIdLabel];
  return owner === serverId;
}

export function containerConfigHash(labels: ContainerLabels) {
  return labels?.[configHashLabel];
}
