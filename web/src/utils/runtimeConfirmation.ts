import type { ConfirmationOptions } from "../components/ConfirmationModal";
import type { PlayerSnapshot } from "../types";

export type RuntimeAction = "start" | "stop" | "restart";

const maxListedNames = 8;

export function onlinePlayerCount(snapshot: PlayerSnapshot | undefined) {
  if (!snapshot) return 0;
  if (snapshot.state !== "live" && snapshot.state !== "stale") return 0;
  return snapshot.online > 0 ? snapshot.online : 0;
}

function onlinePlayerList(snapshot: PlayerSnapshot, count: number) {
  const names = snapshot.names.slice(0, maxListedNames);
  if (!names.length) return "";
  const hidden = Math.max(count, snapshot.names.length) - names.length;
  return hidden > 0 ? `${names.join(", ")} and ${hidden} more` : names.join(", ");
}

export function runtimeActionConfirmation(
  action: RuntimeAction,
  serverName: string,
  snapshot: PlayerSnapshot | undefined
): ConfirmationOptions | null {
  if (action === "start") return null;
  const count = onlinePlayerCount(snapshot);
  const playerLabel = count === 1 ? "1 player is" : `${count} players are`;
  const names = snapshot && count > 0 ? onlinePlayerList(snapshot, count) : "";
  const staleNote = snapshot?.state === "stale"
    ? " The panel could not refresh the player list, so this count may be out of date."
    : "";
  const stopping = action === "stop";

  return {
    title: stopping ? `Stop ${serverName}?` : `Restart ${serverName}?`,
    description: count > 0
      ? `${playerLabel} currently connected to ${serverName}.${staleNote}`
      : stopping
        ? `${serverName} will remain offline until it is started again.`
        : `${serverName} will be temporarily unavailable while it restarts.`,
    details: names || undefined,
    warning: count > 0
      ? stopping
        ? "Everyone online is disconnected immediately, and the server stays offline until you start it again."
        : "Everyone online is disconnected immediately and can only rejoin once the server finishes starting."
      : undefined,
    textInput: {
      label: stopping ? "Reason for stopping" : "Reason for restarting (optional)",
      description: "Saved with the server operation so administrators can trace why this action was taken.",
      placeholder: stopping ? "Why is this server being stopped?" : "Why is this server being restarted?",
      required: stopping,
      maxLength: 500,
      rows: 3
    },
    confirmLabel: stopping ? "Stop server" : "Restart server",
    cancelLabel: "Keep running",
    variant: stopping ? "critical" : "primary"
  };
}
