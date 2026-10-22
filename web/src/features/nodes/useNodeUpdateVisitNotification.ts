import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { NodeView } from "../../types";
import { nodesWithAvailableUpdates } from "../../utils/nodeUpdates";

export const nodeUpdateNotificationMuteMs = 3 * 24 * 60 * 60 * 1000;
export const nodeUpdateNotificationMuteStorageKey = "serversentinel.nodeUpdateNotificationsMutedUntil";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "setItem">;

export function nodeUpdateVisitNotificationText(nodes: NodeView[], panelVersion: string, panelBuildId?: string, demoMode = false) {
  if (demoMode) return "";
  const updateNodes = nodesWithAvailableUpdates(nodes, panelVersion, panelBuildId)
    .filter((node) => node.updateNotificationsEnabled !== false);
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
  demoMode,
  nodes,
  panelVersion,
  panelBuildId,
  onReviewNodes
}: {
  ready: boolean;
  demoMode: boolean;
  nodes: NodeView[];
  panelVersion: string;
  panelBuildId?: string;
  onReviewNodes(nodeId?: string): void;
}) {
  const checkedRef = useRef(false);
  const reviewRef = useRef(onReviewNodes);
  reviewRef.current = onReviewNodes;

  useEffect(() => {
    if (!ready || demoMode || checkedRef.current) return;
    checkedRef.current = true;
    const message = nodeUpdateVisitNotificationText(nodes, panelVersion, panelBuildId, demoMode);
    if (!message) return;
    try {
      if (nodeUpdateVisitNotificationMuted(window.localStorage)) return;
    } catch {
      // Storage can be blocked by browser privacy settings; the notification still works.
    }

    const updateNodes = nodesWithAvailableUpdates(nodes, panelVersion, panelBuildId)
      .filter((node) => node.updateNotificationsEnabled !== false);
    toast.warning(message, {
      id: "node-update-available",
      className: "sonnerToast nodeUpdateToast",
      description: updateNodes.length > 1 ? updateNodes.map((node) => node.name).join(", ") : undefined,
      duration: 15_000,
      action: {
        label: updateNodes.length === 1 ? "View node" : "View nodes",
        onClick: () => reviewRef.current(updateNodes.length === 1 ? updateNodes[0].id : undefined)
      },
      cancel: {
        label: "Remind in 3 days",
        onClick: () => {
          try {
            muteNodeUpdateVisitNotification(window.localStorage);
          } catch {
            // The toast action remains safe when persistent browser storage is unavailable.
          }
        }
      }
    });
  }, [demoMode, nodes, panelBuildId, panelVersion, ready]);
}
