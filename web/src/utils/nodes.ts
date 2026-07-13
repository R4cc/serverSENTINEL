import type { ManagedNode, NodeOperation } from "../types";

export type NodeOperationAdvanceResult = {
  operation?: NodeOperation;
  outcome: "pending" | "completed" | "mismatch";
};

export function advanceNodeOperation(
  operation: NodeOperation,
  node: ManagedNode | undefined,
  now: number,
  graceMs: number,
  reconnectSettleMs = 15_000
): NodeOperationAdvanceResult {
  const observedOffline = Boolean(operation.observedOffline || (node && node.status !== "online"));
  const connectionChanged = Boolean(node?.connectedAt && operation.startedConnectedAt && node.connectedAt !== operation.startedConnectedAt);
  const reconnected = Boolean(node?.status === "online" && (observedOffline || connectionChanged));
  const reconnectedAt = operation.reconnectedAt ?? (reconnected ? now : undefined);
  const targetMatches = operation.kind === "update"
    && Boolean(operation.targetVersion)
    && node?.agentVersion === operation.targetVersion
    && (!operation.targetBuildId || node?.buildId === operation.targetBuildId);

  if (operation.kind === "update" && targetMatches && (reconnected || now - operation.startedAt >= 3_000)) {
    return { outcome: "completed" };
  }
  if (reconnected) {
    if (operation.kind === "restart") return { outcome: "completed" };
    if (reconnectedAt !== undefined && now - reconnectedAt >= reconnectSettleMs) return { outcome: "mismatch" };
  }

  const phase = now - operation.startedAt >= graceMs ? "timed-out" : operation.phase;
  if (
    phase === operation.phase
    && observedOffline === Boolean(operation.observedOffline)
    && reconnectedAt === operation.reconnectedAt
  ) {
    return { operation, outcome: "pending" };
  }
  return { operation: { ...operation, phase, observedOffline, reconnectedAt }, outcome: "pending" };
}

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

function isNodeCompatible(node: ManagedNode) {
  return node.compatibility !== "incompatible";
}

function isNodeDockerUsable(node: ManagedNode) {
  return node.dockerStatus !== "unavailable";
}

export function isNodeRuntimeUsable(node: ManagedNode) {
  return node.status === "online" && isNodeCompatible(node) && isNodeDockerUsable(node);
}

export function nodeRestartImpactMessage(node: ManagedNode) {
  return node.isInternal
    ? "Running servers are not restarted. They stay online and reachable, but the Panel and its controls will be temporarily unavailable."
    : "Running servers on this node are not restarted. They stay online and reachable, but their status and controls in the Panel will be temporarily unavailable until the node reconnects.";
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
