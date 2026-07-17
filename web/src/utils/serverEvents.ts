export const playerReconnectWindowMs = 30_000;

export function playerEventSubject(event: {
  eventType: string;
  subject?: string;
  text?: string;
  message?: string;
}) {
  if (event.subject?.trim()) return event.subject.trim();
  const label = event.text || event.message || "";
  if (event.eventType === "player_joined") return label.replace(/\s+joined$/i, "").trim();
  if (event.eventType === "player_left") return label.replace(/\s+left$/i, "").trim();
  return "";
}

export function samePlayerName(left: string, right: string) {
  return Boolean(left && right && left.localeCompare(right, undefined, { sensitivity: "accent" }) === 0);
}
