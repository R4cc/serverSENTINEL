import { useMemo } from "react";
import { serverRuntimeDefinition } from "@serversentinel/contracts";
import { demoServer, demoServerId } from "../demo";
import type { AppState, ContextNode, ManagedServer, ScheduledExecution, ServerStatus } from "../types";
import { minecraftVersionInfo, runtimeVersionInfo, versionValue } from "../utils/format";
import { isNodeRuntimeUsable, nodeBlockReason } from "../utils/nodes";
import { defaultContextNode, emptyPanelContextNode } from "./appConfig";
import { demoFixtureModrinthConfigured, readModsDemoFixture } from "../features/mods/modsDemoFixtures";

export function useServerContext(input: {
  appState: AppState;
  activeServerId: string;
  status: ServerStatus | null;
  demoMode: boolean;
  demoSchedules: ScheduledExecution[];
}) {
  const modsDemoFixture = readModsDemoFixture();
  const effectiveAppState = useMemo<AppState>(() => {
    if (!input.demoMode) return input.appState;
    const runtimeMode = input.appState.runtimeMode ?? "all-in-one";
    return {
      ...input.appState,
      servers: [demoServer(input.demoSchedules), ...input.appState.servers.filter((server) => server.id !== demoServerId)],
      nodes: input.appState.nodes?.length ? input.appState.nodes : (runtimeMode === "panel" ? [] : [defaultContextNode]),
      runtimeMode,
      modrinthApiConfigured: demoFixtureModrinthConfigured(modsDemoFixture),
      dockerSocketMounted: true,
      totalMemory: input.appState.totalMemory || 16 * 1024 * 1024 * 1024
    };
  }, [input.appState, input.demoMode, input.demoSchedules, modsDemoFixture]);

  const panelOnlyMode = effectiveAppState.runtimeMode === "panel";

  const contextNodes = useMemo<ContextNode[]>(() => {
    const sourceNodes = effectiveAppState.nodes?.length ? effectiveAppState.nodes : (panelOnlyMode ? [] : [defaultContextNode]);
    const nodes: ContextNode[] = sourceNodes.filter((node) => !(panelOnlyMode && (node.isInternal || node.type === "local"))).map((node) => ({
      ...node,
      dockerStatus: (node.isInternal || node.type === "local") ? (effectiveAppState.dockerSocketMounted ? "available" : "unavailable") : node.dockerStatus,
      dataPathStatus: (node.isInternal || node.type === "local") ? "ready" : node.dataPathStatus,
      servers: [] as ManagedServer[]
    }));
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    for (const server of effectiveAppState.servers) {
      const nodeId = server.nodeId || "local";
      if (panelOnlyMode && nodeId === "local") continue;
      const node = nodesById.get(nodeId);
      if (node) {
        node.servers.push(server);
      }
    }
    return nodes;
  }, [effectiveAppState.nodes, effectiveAppState.servers, effectiveAppState.dockerSocketMounted, panelOnlyMode]);

  const activeServer = useMemo(() => {
    if (input.demoMode) {
      return effectiveAppState.servers.find((server) => server.id === demoServerId);
    }
    return effectiveAppState.servers.find((server) => server.id === input.activeServerId) ?? effectiveAppState.servers[0];
  }, [input.activeServerId, input.demoMode, effectiveAppState.servers]);

  const activeServerIsDemo = input.demoMode && activeServer?.id === demoServerId;
  const activeNode = useMemo(() => {
    const serverNodeId = activeServer?.nodeId || "local";
    return contextNodes.find((node) => node.id === serverNodeId) ?? contextNodes[0] ?? { ...(panelOnlyMode ? emptyPanelContextNode : defaultContextNode), servers: [] };
  }, [activeServer?.nodeId, contextNodes, panelOnlyMode]);

  const usableContextNodes = useMemo(() => contextNodes.filter(isNodeRuntimeUsable), [contextNodes]);
  const activeMinecraftVersion = activeServer ? versionValue(minecraftVersionInfo(activeServer)) : "Unknown";
  const activeRuntimeVersion = activeServer ? versionValue(runtimeVersionInfo(activeServer)) : "Unknown";
  const activeRuntimeDefinition = activeServer ? serverRuntimeDefinition(activeServer.runtimeProfile.runtimeType) : undefined;
  const activeModContext = `${activeRuntimeDefinition?.displayName ?? "Runtime"} ${activeRuntimeVersion === "Unknown" ? "unknown" : activeRuntimeVersion} - Minecraft ${activeMinecraftVersion === "Unknown" ? "unknown" : activeMinecraftVersion}`;
  const activeModVersionsUnknown = activeRuntimeVersion === "Unknown" || activeMinecraftVersion === "Unknown";
  const activeStatus = input.status?.server.id === activeServer?.id ? input.status : null;
  const activeNodeRuntimeBlocked = Boolean(activeServer && !activeServerIsDemo && !isNodeRuntimeUsable(activeNode));
  const activeNodeBlockReason = nodeBlockReason(activeNode);
  const activeNodeBlockMessage = activeNodeRuntimeBlocked
    ? `${activeNodeBlockReason || "Node unavailable"}. This server belongs to ${activeNode.name}. Runtime actions and file access are unavailable until the node reconnects or the runtime issue is fixed.`
    : "";
  const activeServerUsesInternalNode = activeNode.isInternal || activeNode.type === "local";
  const activeServerDockerSocketMounted = !activeServerUsesInternalNode || effectiveAppState.dockerSocketMounted;

  return {
    effectiveAppState,
    panelOnlyMode,
    contextNodes,
    activeServer,
    activeServerIsDemo,
    activeNode,
    usableContextNodes,
    activeMinecraftVersion,
    activeRuntimeVersion,
    activeFabricLoaderVersion: activeRuntimeVersion,
    activeRuntimeDefinition,
    activeModContext,
    activeModVersionsUnknown,
    activeStatus,
    activeNodeRuntimeBlocked,
    activeNodeBlockReason,
    activeNodeBlockMessage,
    activeServerUsesInternalNode,
    activeServerDockerSocketMounted
  };
}
