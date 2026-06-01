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

export function nodeBlockReason(node: ManagedNode) {
  if (node.status === "offline") return "Node offline";
  if (node.status === "unknown") return "Node has not connected yet";
  if (node.compatibility === "incompatible") return "Node agent is incompatible";
  if (node.dockerStatus === "unavailable") return "Docker is unavailable on this node";
  return "";
}

export function nodeWarnings(node: ManagedNode) {
  const warnings: string[] = [];
  if (node.status === "offline") warnings.push("Node is offline.");
  if (node.status === "unknown") warnings.push("Node has not connected yet.");
  if (node.compatibility === "incompatible") warnings.push("Agent protocol is incompatible with this panel.");
  if (node.compatibility === "unknown") warnings.push("Agent compatibility is unknown.");
  if (node.dockerStatus === "unavailable") warnings.push("Docker is unavailable.");
  if (!node.dockerStatus || node.dockerStatus === "unknown") warnings.push("Docker availability is unknown.");
  if (node.dataPathStatus && node.dataPathStatus !== "ready") warnings.push(nodeDataPathLabel(node));
  if (node.hasPendingJoinToken) warnings.push("Join token is pending.");
  return warnings;
}
