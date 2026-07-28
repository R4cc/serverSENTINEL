import { useEffect, useState } from "react";
import { api } from "../../api";
import { defaultNodeDataPath } from "../../app/appConfig";
import type { RequestConfirmation } from "../../components/ConfirmationModal";
import type {
  ContextNode,
  CreateNodeResponse,
  ManagedNode,
  NodeInstallResponse,
  NodeManualRecovery,
  NodeOperation,
  NodeUpdateResponse,
  NodeView
} from "../../types";
import { errorMessage } from "../../utils/appHelpers";
import { advanceNodeOperation, isNodeRuntimeUsable, nodeRestartImpactMessage } from "../../utils/nodes";

/** How long a node may stay disconnected after an update before it is treated as failed. */
export const nodeUpdateGraceMs = 5 * 60 * 1000;

type Notify = (type: "success" | "error" | "info" | "warning", text: string) => void;

type NodesWorkspaceInputs = {
  contextNodes: ContextNode[];
  panelVersion: string;
  panelBuildId?: string;
  demoMode: boolean;
  canManageNodes: boolean;
  currentPanelUrl(): string;
  notify: Notify;
  requestConfirmation: RequestConfirmation;
  refreshApp(options?: { silent?: boolean }): Promise<void>;
};

export function useNodesWorkspace({
  contextNodes,
  panelVersion,
  panelBuildId,
  demoMode,
  canManageNodes,
  currentPanelUrl,
  notify,
  requestConfirmation,
  refreshApp
}: NodesWorkspaceInputs) {
  const [busyNodeId, setBusyNodeId] = useState("");
  const [nodeDetails, setNodeDetails] = useState<NodeView | null>(null);
  const [nodeOperations, setNodeOperations] = useState<Record<string, NodeOperation>>({});
  const [nodeOperationNow, setNodeOperationNow] = useState(() => Date.now());
  const [nodeManualRecoveryById, setNodeManualRecoveryById] = useState<Record<string, NodeManualRecovery>>({});
  const [installResult, setInstallResult] = useState<NodeInstallResponse | CreateNodeResponse | null>(null);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [addNodeResult, setAddNodeResult] = useState<CreateNodeResponse | null>(null);
  const [installMethod, setInstallMethod] = useState<"compose" | "run">("run");

  const hasWaitingNodeOperation = Object.values(nodeOperations).some((operation) => operation.phase === "waiting");

  function forgetManualRecovery(nodeId: string) {
    setNodeManualRecoveryById((current) => {
      if (!current[nodeId]) return current;
      const next = { ...current };
      delete next[nodeId];
      return next;
    });
  }

  useEffect(() => {
    if (!hasWaitingNodeOperation) return;
    const interval = window.setInterval(() => setNodeOperationNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [hasWaitingNodeOperation]);

  useEffect(() => {
    if (Object.keys(nodeOperations).length === 0) return;
    const next = { ...nodeOperations };
    const completed: Array<{ node: NodeView; operation: NodeOperation }> = [];
    const mismatched: Array<{ node: NodeView; operation: NodeOperation }> = [];
    let changed = false;

    for (const [nodeId, operation] of Object.entries(nodeOperations)) {
      const node = contextNodes.find((candidate) => candidate.id === nodeId);
      const result = advanceNodeOperation(operation, node, nodeOperationNow, nodeUpdateGraceMs);
      if (result.outcome === "completed" || result.outcome === "mismatch") {
        delete next[nodeId];
        changed = true;
        if (node) (result.outcome === "completed" ? completed : mismatched).push({ node, operation });
        continue;
      }
      if (result.operation !== operation && result.operation) {
        next[nodeId] = result.operation;
        changed = true;
      }
    }

    if (changed) setNodeOperations(next);
    for (const { node, operation } of completed) {
      forgetManualRecovery(node.id);
      notify("success", operation.kind === "update"
        ? `${node.name} updated${operation.targetVersion ? ` to ${operation.targetVersion}` : ""}.`
        : `${node.name} restarted and reconnected.`);
    }
    for (const { node, operation } of mismatched) {
      const expected = [operation.targetVersion, operation.targetBuildId?.slice(0, 12)].filter(Boolean).join(" build ");
      setNodeManualRecoveryById((current) => ({
        ...current,
        [node.id]: { message: `${node.name} reconnected but still reports its previous release${expected ? `. Expected ${expected}` : ""}. Refresh or retry the update.` }
      }));
      notify("warning", `${node.name} reconnected without the expected update.`);
    }
  }, [contextNodes, nodeOperationNow, nodeOperations]);

  useEffect(() => {
    if (!hasWaitingNodeOperation || demoMode) return;
    let inFlight = false;
    const interval = window.setInterval(() => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      void refreshApp({ silent: true }).finally(() => {
        inFlight = false;
      });
    }, 5_000);
    return () => window.clearInterval(interval);
  }, [hasWaitingNodeOperation, demoMode]);

  useEffect(() => {
    setNodeManualRecoveryById((current) => {
      const next = { ...current };
      let changed = false;
      for (const nodeId of Object.keys(current)) {
        const node = contextNodes.find((candidate) => candidate.id === nodeId);
        const targetCurrent = node?.status === "online"
          && node.agentVersion === panelVersion
          && (!panelBuildId || node.buildId === panelBuildId);
        if (targetCurrent) {
          delete next[nodeId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [contextNodes, panelBuildId, panelVersion]);

  useEffect(() => {
    if (!addNodeOpen || !addNodeResult || demoMode) return;
    const currentNode = contextNodes.find((node) => node.id === addNodeResult.node.id);
    if (currentNode && currentNode.status === "online" && isNodeRuntimeUsable(currentNode)) return;
    const interval = window.setInterval(() => {
      if (document.hidden) return;
      void refreshApp();
    }, 2500);
    return () => window.clearInterval(interval);
  }, [addNodeOpen, addNodeResult?.node.id, contextNodes, demoMode]);

  async function refreshNodes() {
    await refreshApp();
    notify("success", "Node status refreshed");
  }

  async function viewNodeDetails(node: NodeView) {
    setNodeDetails(node);
    if (demoMode) return;
    setBusyNodeId(node.id);
    try {
      const details = await api<ManagedNode>(`/api/nodes/${node.id}`);
      setNodeDetails(details);
    } catch (error) {
      notify("error", errorMessage(error, "Could not load node details."));
    } finally {
      setBusyNodeId("");
    }
  }

  async function showNodeInstall(node: NodeView) {
    setBusyNodeId(node.id);
    try {
      const result = await api<NodeInstallResponse>(`/api/nodes/${node.id}/install?panelUrl=${encodeURIComponent(currentPanelUrl())}&dataMount=${encodeURIComponent(defaultNodeDataPath)}`);
      setInstallMethod("run");
      setInstallResult(result);
    } catch (error) {
      notify("error", errorMessage(error, "Could not load install instructions."));
    } finally {
      setBusyNodeId("");
    }
  }

  async function rotateNodeToken(node: NodeView) {
    if (node.isInternal || !canManageNodes) return;
    setBusyNodeId(node.id);
    try {
      const result = await api<CreateNodeResponse>(`/api/nodes/${node.id}/rotate-token`, {
        method: "POST",
        body: JSON.stringify({ panelUrl: currentPanelUrl(), dataMount: defaultNodeDataPath })
      });
      setInstallMethod("run");
      setInstallResult(result);
      notify("success", `Rotated join token for ${node.name}`);
      await refreshApp();
    } catch (error) {
      notify("error", errorMessage(error, "Could not rotate the join token."));
    } finally {
      setBusyNodeId("");
    }
  }

  async function updateNodeImage(node: NodeView) {
    if (node.isInternal || !canManageNodes) return;
    const buildText = panelBuildId ? ` build ${panelBuildId.slice(0, 12)}` : "";
    const sameVersion = node.agentVersion === panelVersion;
    const actionLabel = sameVersion ? "Update" : "Upgrade";
    const versionText = sameVersion
      ? ` to ${panelVersion}${buildText}`
      : node.agentVersion ? ` from ${node.agentVersion} to ${panelVersion}${buildText}` : ` to ${panelVersion}${buildText}`;
    const confirmed = await requestConfirmation({
      title: `${actionLabel} ${node.name}?`,
      description: `${actionLabel} this node${versionText}.`,
      details: nodeRestartImpactMessage(node),
      warning: "The node may disconnect briefly while its container is recreated.",
      confirmLabel: `${actionLabel} node`,
      variant: "primary"
    });
    if (!confirmed) return;
    setBusyNodeId(node.id);
    try {
      const result = await api<NodeUpdateResponse>(`/api/nodes/${node.id}/update`, {
        method: "POST",
        body: JSON.stringify({})
      });
      if (result.mode === "offline") {
        setNodeManualRecoveryById((current) => ({
          ...current,
          [node.id]: { message: result.message, command: result.command, image: result.image }
        }));
        setNodeDetails((current) => current?.id === node.id ? current : node);
        notify("info", result.message);
        return;
      }
      if (result.mode === "current") {
        notify("success", result.message || `${node.name} is already current.`);
        await refreshApp({ silent: true });
        return;
      }
      notify("info", result.message || `Node ${node.name} update started.`);
      if (result.ok && result.mode === "self") {
        const startedAt = Date.now();
        forgetManualRecovery(node.id);
        setNodeOperations((current) => ({
          ...current,
          [node.id]: {
            kind: "update",
            phase: "waiting",
            startedAt,
            startedConnectedAt: node.connectedAt,
            targetVersion: panelVersion,
            targetBuildId: panelBuildId
          }
        }));
        setNodeOperationNow(startedAt);
      }
      window.setTimeout(() => void refreshApp(), 5000);
    } catch (error) {
      notify("error", errorMessage(error, "Could not start the node update."));
    } finally {
      setBusyNodeId("");
    }
  }

  async function restartNode(node: NodeView) {
    if (!canManageNodes) return;
    const confirmed = await requestConfirmation({
      title: node.isInternal ? "Restart the Panel container?" : `Restart ${node.name}?`,
      description: node.isInternal
        ? `Restart the Panel container (${node.name}).`
        : `Restart the node container for ${node.name}.`,
      details: nodeRestartImpactMessage(node),
      warning: node.isInternal
        ? "Your current session will disconnect temporarily while the Panel restarts."
        : "The node will disconnect briefly while its container restarts.",
      confirmLabel: node.isInternal ? "Restart Panel" : "Restart node",
      variant: "primary"
    });
    if (!confirmed) return;
    setBusyNodeId(node.id);
    try {
      const result = await api<{ ok: boolean; message?: string }>(`/api/nodes/${node.id}/restart`, {
        method: "POST"
      });
      notify("info", result.message || `Node ${node.name} restart started.`);
      if (result.ok) {
        const startedAt = Date.now();
        setNodeOperations((current) => ({
          ...current,
          [node.id]: {
            kind: "restart",
            phase: "waiting",
            startedAt,
            startedConnectedAt: node.connectedAt
          }
        }));
        setNodeOperationNow(startedAt);
      }
      window.setTimeout(() => void refreshApp(), 5000);
    } catch (error) {
      notify("error", errorMessage(error, "Could not restart the node container."));
    } finally {
      setBusyNodeId("");
    }
  }

  async function removeNode(node: ContextNode, force = false) {
    if (node.isInternal || !canManageNodes) return;
    const assignedMessage = node.servers.length
      ? force
        ? `This will remove ${node.servers.length} assigned server record${node.servers.length === 1 ? "" : "s"} from the panel even if managed container cleanup cannot finish. Remote server files are not deleted.`
        : `This will remove managed containers for ${node.servers.length} assigned server${node.servers.length === 1 ? "" : "s"}, then remove the server record${node.servers.length === 1 ? "" : "s"} from the panel. Remote server files are not deleted.`
      : undefined;
    const confirmed = await requestConfirmation({
      title: `${force ? "Force remove" : "Remove"} ${node.name}?`,
      description: force ? "Force-remove this node from the Panel." : "Remove this node from the Panel.",
      details: assignedMessage,
      warning: "This action cannot be undone.",
      confirmLabel: force ? "Force remove node" : "Remove node",
      variant: "critical"
    });
    if (!confirmed) return;
    setBusyNodeId(node.id);
    try {
      const result = await api<{
        ok: boolean;
        deletedServers?: number;
        selfRemoval?: { ok: boolean; message: string };
        serverCleanup?: {
          attempted: number;
          deletedContainers: number;
          failed: Array<{ serverId: string; serverName: string; message: string }>;
          skippedReason?: string;
        };
      }>(`/api/nodes/${node.id}${force ? "?force=true" : ""}`, { method: "DELETE" });
      const removedServers = result.deletedServers ?? 0;
      const selfStopSuffix = result.selfRemoval?.ok ? " The node container will stop itself." : result.selfRemoval?.message ? ` ${result.selfRemoval.message}` : "";
      const cleanupFailures = result.serverCleanup?.failed.length ?? 0;
      const cleanupWarning = result.serverCleanup?.skippedReason
        ? ` ${result.serverCleanup.skippedReason}`
        : cleanupFailures
          ? ` ${cleanupFailures} server container cleanup ${cleanupFailures === 1 ? "failure was" : "failures were"} reported.`
          : "";
      notify(cleanupWarning ? "warning" : "success", `${removedServers ? `Removed ${node.name} and ${removedServers} server${removedServers === 1 ? "" : "s"}` : `Removed ${node.name}`}.${cleanupWarning}${selfStopSuffix}`);
      if (nodeDetails?.id === node.id) setNodeDetails(null);
      if (installResult?.node.id === node.id) setInstallResult(null);
      setNodeOperations((current) => {
        if (!current[node.id]) return current;
        const next = { ...current };
        delete next[node.id];
        return next;
      });
      forgetManualRecovery(node.id);
      await refreshApp();
    } catch (error) {
      notify("error", errorMessage(error, "Could not remove the node."));
    } finally {
      setBusyNodeId("");
    }
  }

  async function createNode(input: { name: string; panelUrl: string; dataMount: string }) {
    if (!canManageNodes) return;
    setBusyNodeId("create");
    try {
      const result = await api<CreateNodeResponse>("/api/nodes", {
        method: "POST",
        body: JSON.stringify({
          name: input.name,
          panelUrl: input.panelUrl,
          dataMount: input.dataMount
        })
      });
      setInstallMethod("run");
      setAddNodeResult(result);
      notify("success", `Created pending node ${result.node.name}`);
      await refreshApp();
    } catch (error) {
      notify("error", errorMessage(error, "Could not create the node."));
    } finally {
      setBusyNodeId("");
    }
  }

  /** Clears any stale install output without opening the dialog. */
  function resetAddNode() {
    setAddNodeResult(null);
    setInstallMethod("run");
  }

  function openAddNode() {
    resetAddNode();
    setAddNodeOpen(true);
  }

  return {
    busyNodeId,
    busy: Boolean(busyNodeId),
    selectedNode: nodeDetails ? contextNodes.find((node) => node.id === nodeDetails.id) ?? nodeDetails : null,
    nodeOperations,
    nodeOperationNow,
    nodeManualRecoveryById,
    installResult,
    addNodeOpen,
    addNodeResult,
    installMethod,
    onInstallMethodChange: setInstallMethod,
    onOpenAddNode: openAddNode,
    onCloseAddNode: () => {
      setAddNodeOpen(false);
      setAddNodeResult(null);
    },
    onDoneAddNode: () => {
      setAddNodeOpen(false);
      setAddNodeResult(null);
      void refreshApp();
    },
    onCreateNode: createNode,
    resetAddNode,
    refreshNodes,
    onRefresh: () => void refreshNodes(),
    onViewDetails: viewNodeDetails,
    onShowInstall: showNodeInstall,
    onRotateToken: rotateNodeToken,
    onUpdateNode: updateNodeImage,
    onRestartNode: restartNode,
    onRemoveNode: removeNode,
    onCloseDetails: () => setNodeDetails(null),
    onClearInstall: () => setInstallResult(null)
  };
}
