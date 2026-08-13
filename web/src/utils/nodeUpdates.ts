import type { NodeView } from "../types";

function compareVersions(left?: string, right?: string) {
  if (!left || !right) return null;
  const parse = (value: string) => {
    const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
  };
  const leftParts = parse(left);
  const rightParts = parse(right);
  if (!leftParts || !rightParts) return left === right ? 0 : null;
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export function nodeVersionState(node: NodeView, panelVersion: string) {
  if (node.isInternal || !node.agentVersion) return "unknown";
  const comparison = compareVersions(node.agentVersion, panelVersion);
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
