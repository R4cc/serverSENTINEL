import type { NodeUpdateFailure } from "@serversentinel/contracts";
import type { StorageDatabase } from "../storage/database.js";
import { normalizeNodeUpdateFailure } from "./protocol.js";

const metadataKeyPrefix = "node-update-failure:";

function metadataKey(nodeId: string) {
  return `${metadataKeyPrefix}${nodeId}`;
}

/**
 * The last unresolved update attempt for a node. It lives in metadata rather than on the node row
 * because it is transient operator-facing state: it is written when an attempt fails, and cleared
 * when the next attempt starts, when the node arrives on the expected release, or on dismissal.
 */
export function readNodeUpdateFailure(storage: StorageDatabase, nodeId: string): NodeUpdateFailure | undefined {
  const value = storage.metadata(metadataKey(nodeId));
  if (!value) return undefined;
  try {
    return normalizeNodeUpdateFailure(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function setNodeUpdateFailure(storage: StorageDatabase, nodeId: string, failure: NodeUpdateFailure) {
  storage.setMetadata(metadataKey(nodeId), JSON.stringify(failure));
}

export function clearNodeUpdateFailure(storage: StorageDatabase, nodeId: string) {
  if (!storage.metadata(metadataKey(nodeId))) return;
  storage.setMetadata(metadataKey(nodeId), "");
}
