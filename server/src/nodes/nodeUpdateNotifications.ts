import type { StorageDatabase } from "../storage/database.js";

const metadataKeyPrefix = "node-update-notifications:";

function metadataKey(nodeId: string) {
  return `${metadataKeyPrefix}${nodeId}`;
}

export function nodeUpdateNotificationsEnabled(storage: StorageDatabase, nodeId: string) {
  return storage.metadata(metadataKey(nodeId)) !== "disabled";
}

export function setNodeUpdateNotificationsEnabled(storage: StorageDatabase, nodeId: string, enabled: boolean) {
  storage.setMetadata(metadataKey(nodeId), enabled ? "enabled" : "disabled");
}
