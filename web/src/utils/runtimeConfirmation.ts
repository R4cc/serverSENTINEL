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
  if (action === "start" || !snapshot) return null;
  const count = onlinePlayerCount(snapshot);
  if (count === 0) return null;

  const playerLabel = count === 1 ? "1 player is" : `${count} players are`;
  const names = onlinePlayerList(snapshot, count);
  const staleNote = snapshot.state === "stale"
    ? " The panel could not refresh the player list, so this count may be out of date."
    : "";

  return {
    title: action === "stop" ? "Stop the server with players online?" : "Restart the server with players online?",
    description: `${playerLabel} currently connected to ${serverName}.${staleNote}`,
    details: names || undefined,
    warning: action === "stop"
      ? "Everyone online is disconnected immediately, and the server stays offline until you start it again."
      : "Everyone online is disconnected immediately and can only rejoin once the server finishes starting.",
    confirmLabel: action === "stop" ? "Stop server" : "Restart server",
    cancelLabel: "Keep running",
    variant: action === "stop" ? "critical" : "primary"
  };
}
