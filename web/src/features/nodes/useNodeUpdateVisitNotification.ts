import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { NodeView } from "../../types";
import { nodeUpdateAvailable } from "../../utils/nodeUpdates";

export const nodeUpdateNotificationMuteMs = 3 * 24 * 60 * 60 * 1000;
export const nodeUpdateNotificationMuteStorageKey = "serversentinel.nodeUpdateNotificationsMutedUntil";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function nodeUpdateVisitNotificationText(nodes: NodeView[], panelVersion: string, panelBuildId?: string) {
  const updateNodes = nodes.filter((node) => node.updateNotificationsEnabled !== false
    && nodeUpdateAvailable(node, panelVersion, panelBuildId));
  if (updateNodes.length === 0) return "";
  if (updateNodes.length > 1) return "Multiple nodes have an update available.";
  return `${updateNodes[0].name} has an update available.`;
}

export function nodeUpdateVisitNotificationMuted(storage: StorageReader, now = Date.now()) {
  const mutedUntil = Number(storage.getItem(nodeUpdateNotificationMuteStorageKey));
  return Number.isFinite(mutedUntil) && mutedUntil > now;
}

export function muteNodeUpdateVisitNotification(storage: StorageWriter, now = Date.now()) {
  storage.setItem(nodeUpdateNotificationMuteStorageKey, String(now + nodeUpdateNotificationMuteMs));
}

export function useNodeUpdateVisitNotification({
  ready,
  nodes,
  panelVersion,
  panelBuildId
}: {
  ready: boolean;
  nodes: NodeView[];
  panelVersion: string;
  panelBuildId?: string;
}) {
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!ready || checkedRef.current) return;
    checkedRef.current = true;
    const message = nodeUpdateVisitNotificationText(nodes, panelVersion, panelBuildId);
    if (!message) return;
    try {
      if (nodeUpdateVisitNotificationMuted(window.localStorage)) return;
    } catch {
      // Storage can be blocked by browser privacy settings; the notification still works.
    }

    toast.warning(message, {
      id: "node-update-available",
      duration: 15_000,
      action: {
        label: "Mute for 3 days",
        onClick: () => {
          try {
            muteNodeUpdateVisitNotification(window.localStorage);
          } catch {
            // The toast action remains safe when persistent browser storage is unavailable.
          }
        }
      }
    });
  }, [nodes, panelBuildId, panelVersion, ready]);
}
