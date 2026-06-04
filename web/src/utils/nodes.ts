import type { ManagedNode } from "../types";

export function nodeStatusLabel(status: ManagedNode["status"]) {
  if (status === "online") return "Node online";
  if (status === "offline") return "Node offline";
  return "Node status unknown";
}

export function nodeCompatibilityLabel(node: ManagedNode) {
  if (node.compatibility === "compatible") return "Compatible";
  if (node.compatibility === "incompatible") return "Incompatible";
  return "Compatibility unknown";
}

export function nodeDockerLabel(node: ManagedNode) {
  if (node.dockerStatus === "available") return "Docker available";
  if (node.dockerStatus === "unavailable") return "Docker unavailable";
  return "Docker unknown";
}

export function nodeDataPathLabel(node: ManagedNode) {
  if (node.dataPathStatus === "ready") return "Data path writable";
  if (node.dataPathStatus === "missing") return "Data path missing";
  return "Data path unknown";
}

export function isNodeCompatible(node: ManagedNode) {
  return node.compatibility !== "incompatible";
}

export function isNodeDockerUsable(node: ManagedNode) {
  return node.dockerStatus !== "unavailable";
}

export function isNodeRuntimeUsable(node: ManagedNode) {
  return node.status === "online" && isNodeCompatible(node) && isNodeDockerUsable(node);
}

export function nodeJoinTokenExpired(node: ManagedNode) {
  return Boolean(node.hasPendingJoinToken && node.joinTokenExpiresAt && new Date(node.joinTokenExpiresAt).getTime() <= Date.now());
}

export function nodeBlockReason(node: ManagedNode) {
  if (nodeJoinTokenExpired(node)) return "Join token expired";
  if (node.hasPendingJoinToken && node.status === "unknown") return "Waiting for node to join";
  if (node.status === "offline") return "Node offline";
  if (node.status === "unknown") return "Node has not connected yet";
  if (node.compatibility === "incompatible") return "Node agent is incompatible";
  if (node.dockerStatus === "unavailable") return "Docker is unavailable on this node";
  if (!node.dockerStatus || node.dockerStatus === "unknown") return "Docker status is unknown";
  if (node.dataPathStatus === "missing") return "Node data path is missing";
  return "";
}

export function nodeWarnings(node: ManagedNode) {
  const warnings: string[] = [];
  if (nodeJoinTokenExpired(node)) warnings.push("Join token expired. Rotate the token and rerun the install command.");
  else if (node.hasPendingJoinToken) warnings.push("Join token pending. Run the install command before it expires.");
  if (node.status === "offline") warnings.push("Node is offline.");
  if (node.status === "unknown") warnings.push("Node has not connected yet.");
  if (node.compatibility === "incompatible") warnings.push("Agent protocol is incompatible with this panel.");
  if (node.compatibility === "unknown") warnings.push("Agent compatibility is unknown.");
  if (node.dockerStatus === "unavailable") warnings.push("Docker is unavailable.");
  if (!node.dockerStatus || node.dockerStatus === "unknown") warnings.push("Docker availability is unknown.");
  if (node.dataPathStatus && node.dataPathStatus !== "ready") warnings.push(nodeDataPathLabel(node));
  return warnings;
}
