import { parseLogLine } from "../servers/logEvents.js";

/**
 * The one place a Minecraft server tells the panel where a player connected from.
 *
 * Query reports who is online but never their address, and no protocol the panel speaks reports a
 * player's own latency. The login line is the whole source:
 *
 *   [12:34:56] [Server thread/INFO]: Steve[/203.0.113.5:51234] logged in with entity id 42 at (...)
 *
 * Older and plugin-shimmed servers write the same fact through a game profile instead:
 *
 *   ...GameProfile{id=..., name=Steve} (/203.0.113.5:51234) logged in with entity id 42
 *
 * The address leaves this module in memory only. Nothing downstream stores it: it is resolved to a
 * location and dropped, which is why the parsed shape below is deliberately short-lived.
 */
export type PlayerLoginAddress = {
  player: string;
  /** The client address exactly as the server logged it, without the port. Never persisted. */
  address: string;
  /** When the server logged the join, when the line carried a timestamp. */
  at?: string;
};

// The address is matched greedily up to the last bracket before "logged in", because an IPv6
// client is itself written in brackets: `Steve[/[2001:db8::1]:51234] logged in`.
const bracketedLogin = /^(?<player>[^\s[\]]{1,64})\[\/?(?<address>.+)\]\s+logged in\b/i;
const profileLogin = /name=(?<player>[^,}\]\s]{1,64})[^)]*\(\/?(?<address>[^)]+?)\)\s+logged in\b/i;

/**
 * Splits `host:port` where the host may itself be an IPv6 literal.
 *
 * Minecraft writes IPv6 clients as `[2001:db8::1]:51234`, but some launchers and proxies log the
 * bare form, so the last colon is only treated as a port separator when what follows it is a port
 * and what precedes it is not itself a multi-colon address.
 */
export function addressWithoutPort(value: string) {
  const trimmed = value.trim().replace(/^\//, "");
  if (!trimmed) return "";
  const bracketed = trimmed.match(/^\[(?<host>[^\]]+)\](?::\d{1,5})?$/);
  if (bracketed) return bracketed.groups!.host;
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon <= 0) return trimmed;
  const host = trimmed.slice(0, lastColon);
  const port = trimmed.slice(lastColon + 1);
  if (!/^\d{1,5}$/.test(port)) return trimmed;
  return host.includes(":") ? trimmed : host;
}

export function parsePlayerLoginAddress(line: string, referenceDate = new Date()): PlayerLoginAddress | null {
  const parsed = parseLogLine(line, referenceDate);
  if (!parsed || !/logged in\b/i.test(parsed.message)) return null;
  const match = parsed.message.match(bracketedLogin) ?? parsed.message.match(profileLogin);
  if (!match?.groups) return null;
  const player = match.groups.player.trim();
  const address = addressWithoutPort(match.groups.address);
  if (!player || !address) return null;
  return { player, address, at: parsed.timestamp };
}

/**
 * Every login in a block of recent console output, newest last.
 *
 * The same log window is polled repeatedly, so the caller sees the same joins again; upserting by
 * player is what makes that idempotent rather than something this parser has to remember.
 */
export function parsePlayerLoginAddresses(text: string, referenceDate = new Date()) {
  const logins: PlayerLoginAddress[] = [];
  for (const line of text.split(/\r?\n/)) {
    const login = parsePlayerLoginAddress(line, referenceDate);
    if (login) logins.push(login);
  }
  return logins;
}
