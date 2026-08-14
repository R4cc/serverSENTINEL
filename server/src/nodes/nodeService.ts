import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "../config.js";
import { appBuildId, appVersion } from "../buildInfo.js";
import { panelNodeConnections, services } from "../appServices.js";
import { detectedTotalMemory } from "../runtime/local/dockerContainers.js";
import { buildNodeInstallInstructions } from "./installInstructions.js";
import type { NodeInstallInstructions, NodeUpdateFailure } from "@serversentinel/contracts";
import { totalmem } from "node:os";
import { badRequest } from "../http/validation.js";
import { compareVersionStrings } from "../servers/versions.js";
import { throwHttp } from "../http/errors.js";
import { nodeCapabilities, nodeFeatures, nodeProtocolVersion } from "./protocol.js";
import { normalizeNode } from "../storage/nodesRepository.js";
import type { ManagedNode, ManagedServer, PublicNode } from "../types.js";
import { nodeUpdateNotificationsEnabled } from "./nodeUpdateNotifications.js";
import { readNodeUpdateFailure } from "./nodeUpdateStatus.js";

export const localNodeId = "local";
export const nodeImageRepository = "nl2109/serversentinel";
export const nodeImage = config.nodeImage || `${nodeImageRepository}:${appVersion}`;

export function nodeUpdateImageForBuild(configuredImage?: string, buildId?: string, version = appVersion) {
  const configured = configuredImage?.trim();
  if (configured) return configured;
  const build = buildId?.trim();
  if (build && /^[A-Za-z0-9_.-]+$/.test(build)) return `${nodeImageRepository}:${build}`;
  return `${nodeImageRepository}:${version}`;
}

export function nodeUpdateAlreadyCurrent(node: Pick<ManagedNode, "agentVersion" | "buildId">, requestedImage?: string, version = appVersion, buildId = appBuildId) {
  return !requestedImage?.trim() && node.agentVersion === version && (buildId ? node.buildId === buildId : true);
}

/** The release where the node image moved to Distroless and its entrypoint changed. */
export const nodeEntrypointChangeVersion = "26.8.11";

/**
 * Whether a node has to be recreated by hand instead of updating itself. Agents older than the
 * Distroless switch build their replacement container from the config they are running with, which
 * pins the old image's entrypoint; the replacement then cannot start at all. The fix ships in the
 * new agent, so it cannot help the very update that installs it — one manual recreate per node is
 * the only way across, and saying so beats an attempt that always fails.
 */
export function nodeUpdateNeedsManualRecreate(agentVersion?: string, requestedImage?: string, targetVersion = appVersion) {
  if (requestedImage?.trim()) return false;
  return compareVersionStrings(agentVersion, nodeEntrypointChangeVersion) === -1
    && (compareVersionStrings(targetVersion, nodeEntrypointChangeVersion) ?? -1) >= 0;
}

export const minNodeJoinTokenTtlMinutes = 5;
export const maxNodeJoinTokenTtlMinutes = 1440;

export function hashNodeSecret(secret: string) {
  return createHash("sha256").update(secret).digest("hex");
}

export function verifyNodeSecret(secret: string | undefined, expectedHash?: string) {
  if (!secret || !expectedHash) return false;
  const attempted = Buffer.from(hashNodeSecret(secret), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return attempted.length === expected.length && timingSafeEqual(attempted, expected);
}

export function nodeNotFound(nodeId: string): never {
  throwHttp(404, `Node ${nodeId} not found`, { code: "node_not_found" });
}

export function defaultInternalNode(now = new Date().toISOString()): ManagedNode {
  return {
    id: localNodeId,
    name: "Internal Node",
    type: "local",
    status: "online",
    isInternal: true,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
    agentVersion: appVersion,
    buildId: appBuildId,
    protocolVersion: nodeProtocolVersion,
    capabilities: [...nodeCapabilities],
    features: [...nodeFeatures],
    totalMemory: totalmem()
  };
}

export function optionalNodeTotalMemory(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function ensureDefaultInternalNode(nodes: ManagedNode[]) {
  const now = new Date().toISOString();
  const localIndex = nodes.findIndex((node) => node.id === localNodeId);
  if (localIndex === -1) {
    nodes.unshift(defaultInternalNode(now));
    return true;
  }

  const current = nodes[localIndex];
  const normalized: ManagedNode = {
    ...current,
    name: current.name || "Internal Node",
    type: "local",
    status: "online",
    isInternal: true,
    agentVersion: appVersion,
    buildId: appBuildId,
    protocolVersion: nodeProtocolVersion,
    capabilities: [...nodeCapabilities],
    features: [...nodeFeatures],
    updatedAt: current.status === "online" && current.type === "local" && current.isInternal ? current.updatedAt : now,
    lastSeenAt: current.lastSeenAt ?? now,
    totalMemory: totalmem()
  };
  // Compare what the nodes table would actually store. `features` is negotiated per session and
  // dropped by normalizeNode, so comparing the in-memory records reported a change on every call
  // and made readNodes write the whole table — on a poll path that runs per server every few
  // seconds, and which also drops the NodesRepository read cache each time.
  const changed = persistedNodeSnapshot(current) !== persistedNodeSnapshot(normalized);
  nodes[localIndex] = normalized;
  return changed;
}

function persistedNodeSnapshot(node: ManagedNode) {
  return JSON.stringify(normalizeNode(node));
}

export function publicNode(node: ManagedNode, updateNotificationsEnabled = true, lastUpdateFailure?: NodeUpdateFailure): PublicNode {
  const normalized = normalizeNode(node);
  const { secretHash: _secretHash, joinTokenHash: _joinTokenHash, ...publicFields } = normalized;
  return {
    ...publicFields,
    hasPendingJoinToken: Boolean(normalized.joinTokenHash && normalized.joinTokenExpiresAt && new Date(normalized.joinTokenExpiresAt).getTime() > Date.now()),
    updateNotificationsEnabled,
    lastUpdateFailure
  };
}

export function publicNodeWithSettings(node: ManagedNode) {
  return publicNode(
    node,
    nodeUpdateNotificationsEnabled(services.storageDatabase, node.id),
    readNodeUpdateFailure(services.storageDatabase, node.id)
  );
}

export function nodeWithLiveConnectionStatus(node: ManagedNode, connected: boolean): ManagedNode {
  if (node.isInternal || node.type === "local") return node;
  if (connected) return node.status === "online" ? node : { ...node, status: "online" };
  return node.status === "online" ? { ...node, status: "offline" } : node;
}

export async function publicNodes(nodes: ManagedNode[], detectedInternalTotalMemory?: number): Promise<PublicNode[]> {
  const internalTotalMemory = detectedInternalTotalMemory ?? (nodes.some((node) => node.id === localNodeId || node.isInternal)
    ? await detectedTotalMemory()
    : undefined);
  return nodes.map((node) => {
    const publicFields = publicNodeWithSettings(nodeWithLiveConnectionStatus(node, panelNodeConnections.isConnected(node.id)));
    return (node.id === localNodeId || node.isInternal) && internalTotalMemory
      ? { ...publicFields, totalMemory: internalTotalMemory }
      : publicFields;
  });
}

export function nodeInstallInstructions(input: { panelUrl?: string; joinToken?: string; dataMount?: string; nodeName?: string }): NodeInstallInstructions {
  return buildNodeInstallInstructions({ ...input, image: nodeImage, defaultPanelPort: config.port, timeZone: config.timeZone });
}

export function createJoinToken(ttlMinutesInput?: number) {
  const now = new Date();
  const joinToken = randomBytes(32).toString("base64url");
  const ttlMinutes = validateJoinTokenTtlMinutes(ttlMinutesInput);
  return {
    joinToken,
    expiresAt: new Date(now.getTime() + ttlMinutes * 60_000).toISOString()
  };
}

export function validateJoinTokenTtlMinutes(ttlMinutesInput?: unknown): number {
  if (ttlMinutesInput === undefined || ttlMinutesInput === null) return 60;
  if (typeof ttlMinutesInput !== "number" || !Number.isInteger(ttlMinutesInput) || ttlMinutesInput < minNodeJoinTokenTtlMinutes || ttlMinutesInput > maxNodeJoinTokenTtlMinutes) {
    badRequest(`Join token expiry must be a whole number from ${minNodeJoinTokenTtlMinutes} to ${maxNodeJoinTokenTtlMinutes} minutes`);
  }
  return ttlMinutesInput;
}

export async function readNodes() {
  const nodes = services.nodesRepository.list();
  const normalized = nodes.map(normalizeNode).filter((node) => config.runtimeMode !== "panel" || (!node.isInternal && node.type !== "local" && node.id !== localNodeId));
  const changed = config.runtimeMode === "all-in-one" ? ensureDefaultInternalNode(normalized) : normalized.length !== nodes.length;
  if (changed) {
    services.nodesRepository.update((stored) => stored.splice(0, stored.length, ...normalized));
  }
  return normalized;
}

export async function updateNodes(updater: (nodes: ManagedNode[]) => void) {
  services.nodesRepository.update((stored) => {
    const nodes = stored.map(normalizeNode).filter((node) => config.runtimeMode !== "panel" || (!node.isInternal && node.type !== "local" && node.id !== localNodeId));
    if (config.runtimeMode === "all-in-one") ensureDefaultInternalNode(nodes);
    updater(nodes);
    const normalized = nodes.map(normalizeNode).filter((node) => config.runtimeMode !== "panel" || (!node.isInternal && node.type !== "local" && node.id !== localNodeId));
    if (config.runtimeMode === "all-in-one") ensureDefaultInternalNode(normalized);
    stored.splice(0, stored.length, ...normalized);
  });
}

export function findServerNode(server: ManagedServer, nodes: ManagedNode[]) {
  return nodes.find((node) => node.id === server.nodeId);
}

export type NodeServerCleanupFailure = {
  serverId: string;
  serverName: string;
  message: string;
};

export type NodeServerCleanupSummary = {
  attempted: number;
  deletedContainers: number;
  failed: NodeServerCleanupFailure[];
  skippedReason?: string;
};

export async function cleanupNodeServerContainers(input: {
  node: ManagedNode;
  assignedServers: ManagedServer[];
  isConnected: (node: ManagedNode) => boolean;
  deleteServerContainer: (node: ManagedNode, server: ManagedServer) => Promise<unknown>;
}) {
  const summary: NodeServerCleanupSummary = { attempted: 0, deletedContainers: 0, failed: [] };
  if (input.assignedServers.length === 0) return summary;
  if (!input.isConnected(input.node)) {
    summary.skippedReason = `Node ${input.node.name} is offline or not connected. Managed server containers could not be cleaned up.`;
    return summary;
  }

  for (const server of input.assignedServers) {
    summary.attempted += 1;
    try {
      const result = await input.deleteServerContainer(input.node, server) as { deletedContainer?: boolean } | undefined;
      if (result?.deletedContainer !== false) summary.deletedContainers += 1;
    } catch (error) {
      summary.failed.push({
        serverId: server.id,
        serverName: server.displayName,
        message: error instanceof Error ? error.message : "Container cleanup failed"
      });
    }
  }

  return summary;
}

export function nodeServerCleanupError(summary: NodeServerCleanupSummary) {
  if (summary.skippedReason) return summary.skippedReason;
  if (summary.failed.length === 0) return "";
  const names = summary.failed.map((failure) => failure.serverName).join(", ");
  return `Could not clean up ${summary.failed.length} managed server container${summary.failed.length === 1 ? "" : "s"} before deleting the node: ${names}.`;
}

export const activeNodeUpdates = new Map<string, { version?: string; buildId?: string }>();
