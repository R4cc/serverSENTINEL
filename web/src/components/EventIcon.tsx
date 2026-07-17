import type { ServerEvent } from "../types";

export type EventIconKind = ServerEvent["eventType"] | "player_reconnected" | "server_restarted";

export function EventIcon({ kind }: { kind: EventIconKind }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {kind === "player_joined" && <><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.5-3.5 2.3-5 5.5-5 2 0 3.5.6 4.4 2" /><path d="M15 10h6m-3-3 3 3-3 3" /></>}
      {kind === "player_left" && <><circle cx="9" cy="8" r="3" /><path d="M3.5 19c.5-3.5 2.3-5 5.5-5 2 0 3.5.6 4.4 2" /><path d="M21 10h-6m3-3-3 3 3 3" /></>}
      {kind === "player_reconnected" && <><circle cx="8" cy="8" r="3" /><path d="M2.5 19c.5-3.5 2.3-5 5.5-5 1.4 0 2.5.3 3.4.8" /><path d="M14 10a5 5 0 1 1-1 7m1 3-1-3 3-1" /></>}
      {kind === "server_started" && <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 8 6 4-6 4Z" /></>}
      {kind === "server_stopped" && <><rect x="3" y="4" width="18" height="16" rx="3" /><rect x="9" y="9" width="6" height="6" /></>}
      {kind === "server_restarted" && <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M8 12a4 4 0 0 1 7-2m1-2-1 2-2-1" /><path d="M16 12a4 4 0 0 1-7 2m-1 2 1-2 2 1" /></>}
      {kind === "mod_disabled" && <><path d="M8 3h8v4a2 2 0 1 1 0 4v10H8v-4a2 2 0 1 0 0-4Z" /><path d="m4 4 16 16" /></>}
      {kind === "server_crashed" && <><path d="M12 3 2.5 20h19Z" /><path d="M12 9v5m0 3h.01" /></>}
      {kind === "exception_caught" && <><path d="M8 8h8v9a4 4 0 0 1-8 0Z" /><path d="M9 8V6a3 3 0 0 1 6 0v2M4 12h4m8 0h4M5 18l3-2m11 2-3-2" /></>}
      {kind === "server_overloaded" && <><path d="M4 18a8 8 0 1 1 16 0" /><path d="m12 14 4-4" /><path d="M7 18h10" /></>}
    </svg>
  );
}
