import type { ServerEvent } from "./types.js";

function normalizedName(name: string) {
  return name.trim().toLowerCase();
}

function uniquePlayerNames(names?: string[]) {
  if (!names) return undefined;
  const unique = new Map<string, string>();
  for (const value of names) {
    const name = value.trim();
    if (name) unique.set(normalizedName(name), name);
  }
  return [...unique.values()];
}

function eventPlayerName(event: ServerEvent) {
  if (event.subject?.trim()) return event.subject.trim();
  if (event.eventType === "player_joined") return event.message.replace(/\s+joined$/i, "").trim();
  if (event.eventType === "player_left") return event.message.replace(/\s+left$/i, "").trim();
  return "";
}

function eventTimestamp(event: ServerEvent) {
  if (!event.timestamp || /^\d{2}:\d{2}:\d{2}$/.test(event.timestamp)) return undefined;
  const value = new Date(event.timestamp).getTime();
  return Number.isNaN(value) ? undefined : value;
}

function chronologicalEvents(events: ServerEvent[]) {
  const deduplicated = new Map<string, { event: ServerEvent; order: number; timestamp?: number }>();
  events.forEach((event, order) => {
    const timestamp = eventTimestamp(event);
    const key = `${event.eventType}:${event.signature}:${timestamp ?? event.timestamp ?? order}`;
    const existing = deduplicated.get(key);
    if (!existing || existing.event.source === "docker" && event.source === "logs/latest.log") {
      deduplicated.set(key, { event, order, timestamp });
    }
  });
  return [...deduplicated.values()]
    .sort((left, right) => left.timestamp !== undefined && right.timestamp !== undefined
      ? left.timestamp - right.timestamp || left.order - right.order
      : left.order - right.order)
    .map(({ event }) => event);
}

export function inferActivePlayerNames(events: ServerEvent[], playersOnline: number | null | undefined) {
  if (!playersOnline || playersOnline < 1) return [];
  const active = new Map<string, { name: string; order: number }>();
  let order = 0;
  for (const event of chronologicalEvents(events)) {
    order += 1;
    if (event.eventType === "server_started" || event.eventType === "server_stopped" || event.eventType === "server_crashed") {
      active.clear();
      continue;
    }
    const name = eventPlayerName(event);
    if (!name) continue;
    const key = normalizedName(name);
    if (event.eventType === "player_joined") active.set(key, { name, order });
    else if (event.eventType === "player_left") active.delete(key);
  }
  return [...active.values()]
    .sort((left, right) => left.order - right.order)
    .slice(-playersOnline)
    .map(({ name }) => name);
}

export function resolvePlayerNames(queryNames: string[] | undefined, events: ServerEvent[], playersOnline: number | null | undefined) {
  const normalizedQueryNames = uniquePlayerNames(queryNames);
  if (normalizedQueryNames?.length) {
    return { playerNames: normalizedQueryNames, playerNamesSource: "query" as const };
  }
  const inferredNames = inferActivePlayerNames(events, playersOnline);
  if (inferredNames.length) {
    return { playerNames: inferredNames, playerNamesSource: "logs" as const };
  }
  return { playerNames: normalizedQueryNames };
}
