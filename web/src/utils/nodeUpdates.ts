import { compareVersionStrings } from "@serversentinel/contracts";
import type { NodeView } from "../types";

export function nodeVersionState(node: NodeView, panelVersion: string) {
  if (node.isInternal || !node.agentVersion) return "unknown";
  const comparison = compareVersionStrings(node.agentVersion, panelVersion);
  if (comparison === 0) return "current";
  if (comparison === -1) return "older";
  if (comparison === 1) return "newer";
  return "mismatch";
}

export function nodeBuildUpdateAvailable(node: NodeView, panelVersion: string, panelBuildId?: string) {
  return !node.isInternal
    && Boolean(panelBuildId)
    && nodeVersionState(node, panelVersion) === "current"
    && node.buildId !== panelBuildId;
}

export function nodeUpdateAvailable(node: NodeView, panelVersion: string, panelBuildId?: string) {
  return nodeVersionState(node, panelVersion) === "older"
    || nodeBuildUpdateAvailable(node, panelVersion, panelBuildId);
}
