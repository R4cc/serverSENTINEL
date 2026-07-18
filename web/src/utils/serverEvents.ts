export const playerReconnectWindowMs = 30_000;
export const repeatedEventWindowMs = 10 * 60 * 1_000;

export function groupNearbyRepeatedEvents<T extends { signature: string }>(
  events: T[],
  occurredAt: (event: T) => number | null,
  windowMs = repeatedEventWindowMs
) {
  const groups: T[][] = [];

  for (const event of events) {
    const current = groups.at(-1);
    const first = current?.[0];
    const firstTime = first ? occurredAt(first) : null;
    const eventTime = occurredAt(event);
    if (
      current
      && first
      && first.signature === event.signature
      && firstTime !== null
      && eventTime !== null
      && Math.abs(eventTime - firstTime) < windowMs
    ) {
      current.push(event);
    } else {
      groups.push([event]);
    }
  }

  return groups;
}

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
