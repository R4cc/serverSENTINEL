import { createHash } from "node:crypto";
import type { ServerEvent } from "../types.js";

export type ParsedEventInput = {
  eventType: ServerEvent["eventType"];
  severity: ServerEvent["severity"];
  message: string;
  details?: string;
  timestamp?: string;
  source: ServerEvent["source"];
  index: number;
  signature: string;
  subject?: string;
};

export function eventFromParsedLine(input: ParsedEventInput): ServerEvent {
  const id = `${input.source}-${input.index}-${input.timestamp ?? ""}-${createHash("sha1").update(input.signature).digest("hex").slice(0, 8)}`;
  return {
    id,
    eventType: input.eventType,
    type: input.severity,
    severity: input.severity,
    text: input.message,
    message: input.message,
    details: input.details,
    timestamp: input.timestamp,
    signature: input.signature,
    source: input.source,
    subject: input.subject
  };
}

export function eventSignature(eventType: ServerEvent["eventType"], subject?: string) {
  const normalized = subject?.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized ? `${eventType}:${normalized}` : eventType;
}

export function cleanPlayerName(value: string) {
  return value
    .trim()
    .replace(/^"|"$/g, "")
    .replace(/\s+\(\/?[^)]+:\d+\)$/g, "");
}

// Minecraft keeps the client socket address next to the name while a connection is
// still being negotiated (`Steve (/1.2.3.4:5678) lost connection: ...`, `Disconnecting
// /1.2.3.4:5678: ...`) and logs the bare name only once the player is in the world.
// An addressed disconnect therefore belongs to a client that never joined, so it must
// not be reported as a player leaving.
export function connectingClientName(value: string) {
  const trimmed = value.trim();
  return /\(\/?[^)]*:\d+\)$/.test(trimmed) || /^\/?[^\s/]*:\d+$/.test(trimmed);
}

export function cleanModName(value: string) {
  return value.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ");
}

export function conciseEventDetails(value: string) {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized;
}

export function parseLogEvent(line: string, source: ServerEvent["source"], index: number, referenceDate = new Date()): ServerEvent | null {
  const ansiStripped = line.replace(/\u001b\[[0-9;]*m/g, "").trim();
  if (!ansiStripped) return null;

  const tsMatch = ansiStripped.match(/^\[(?<time>\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2})\]/);
  let timestamp: string | undefined;
  let rest = ansiStripped;

  if (tsMatch) {
    const rawTime = tsMatch.groups!.time;
    if (/^\d{2}:\d{2}:\d{2}$/.test(rawTime)) {
      const [hours, minutes, seconds] = rawTime.split(":").map(Number);
      const date = new Date(referenceDate);
      date.setHours(hours, minutes, seconds, 0);
      // Minecraft's time-only log lines refer to the most recent occurrence in
      // the configured runtime zone. Canonicalize that wall time before it
      // crosses the API boundary so browsers in another zone see one instant.
      if (date.getTime() > referenceDate.getTime()) date.setDate(date.getDate() - 1);
      timestamp = date.toISOString();
    } else {
      const normalized = rawTime.replace(" ", "T");
      const date = new Date(normalized);
      if (!Number.isNaN(date.getTime())) {
        timestamp = date.toISOString();
      }
    }
    rest = ansiStripped.slice(tsMatch[0].length).trim();
  }

  let level = "";
  let message = rest;

  const matchModern = rest.match(/^\[(?<thread>[^\]/]+)\/(?<level>[A-Z]+)\]:\s*(?<message>.*)$/);
  if (matchModern) {
    level = matchModern.groups!.level;
    message = matchModern.groups!.message;
  } else {
    const bracketedMatch = rest.match(/^\[(?<thread>[^\]]+)\]\s+\[(?<level>[A-Z]+)\]:\s*(?<message>.*)$/);
    if (bracketedMatch) {
      level = bracketedMatch.groups!.level;
      message = bracketedMatch.groups!.message;
    } else {
      const matchBrackets = rest.match(/^\[(?<level>[A-Z]+)\]:\s*(?<message>.*)$/);
      if (matchBrackets) {
        level = matchBrackets.groups!.level;
        message = matchBrackets.groups!.message;
      } else {
        const matchPlain = rest.match(/^(?<level>[A-Z]+):\s*(?<message>.*)$/);
        if (matchPlain) {
          level = matchPlain.groups!.level;
          message = matchPlain.groups!.message;
        }
      }
    }
  }

  const playerJoin = message.match(/^(.+?) joined the game$/i);
  if (playerJoin) {
    const player = cleanPlayerName(playerJoin[1]);
    return eventFromParsedLine({
      eventType: "player_joined",
      severity: "success",
      message: `${player} joined`,
      timestamp,
      source,
      index,
      signature: eventSignature("player_joined", player),
      subject: player
    });
  }

  const playerLeft = message.match(/^(.+?) left the game$/i);
  if (playerLeft) {
    const player = cleanPlayerName(playerLeft[1]);
    return eventFromParsedLine({
      eventType: "player_left",
      severity: "info",
      message: `${player} left`,
      timestamp,
      source,
      index,
      signature: eventSignature("player_left", player),
      subject: player
    });
  }

  const playerDisconnected = message.match(/^(.+?) lost connection:/i);
  if (playerDisconnected && !connectingClientName(playerDisconnected[1])) {
    const player = cleanPlayerName(playerDisconnected[1]);
    return eventFromParsedLine({
      eventType: "player_left",
      severity: "warning",
      message: `${player} left`,
      timestamp,
      source,
      index,
      signature: eventSignature("player_left", player),
      subject: player
    });
  }

  const disconnectingPlayer = message.match(/^Disconnecting\s+(.+?)\s*(?::\s|:$|$)/i);
  if (disconnectingPlayer && !connectingClientName(disconnectingPlayer[1])) {
    const player = cleanPlayerName(disconnectingPlayer[1]);
    return eventFromParsedLine({
      eventType: "player_left",
      severity: "warning",
      message: `${player} left`,
      timestamp,
      source,
      index,
      signature: eventSignature("player_left", player),
      subject: player
    });
  }

  if (/Done \([^)]+\)! For help, type "help"/i.test(message)) {
    return eventFromParsedLine({
      eventType: "server_started",
      severity: "success",
      message: "Server started",
      timestamp,
      source,
      index,
      signature: eventSignature("server_started")
    });
  }
  if (/Stopping server|Stopping the server|ThreadedAnvilChunkStorage: All chunks are saved/i.test(message)) {
    return eventFromParsedLine({
      eventType: "server_stopped",
      severity: "info",
      message: "Server stopped",
      timestamp,
      source,
      index,
      signature: eventSignature("server_stopped")
    });
  }

  const disabledJar = message.match(/\b([\w .+@()[\]-]+?\.jar(?:\.disabled)?)\b.*\b(?:disabled|disabling)\b/i)
    ?? message.match(/\b(?:disabled|disabling)\b.*\b([\w .+@()[\]-]+?\.jar(?:\.disabled)?)\b/i);
  const disabledMod = disabledJar
    ?? message.match(/\bmod\s+["']?([^"',:]+?)["']?\s+(?:was\s+)?disabled\b/i)
    ?? message.match(/\b(?:disabled|disabling)\s+mod\s+["']?([^"',:]+?)["']?\b/i);
  if (disabledMod) {
    const modName = cleanModName(disabledMod[1]);
    return eventFromParsedLine({
      eventType: "mod_disabled",
      severity: "warning",
      message: `Mod disabled: ${modName}`,
      timestamp,
      source,
      index,
      signature: eventSignature("mod_disabled", modName)
    });
  }

  const overloaded = message.match(/Can't keep up! Is the server overloaded\?\s*(.*)/i);
  if (overloaded) {
    return eventFromParsedLine({
      eventType: "server_overloaded",
      severity: "warning",
      message: "Server is falling behind",
      details: conciseEventDetails(overloaded[1] || message),
      timestamp,
      source,
      index,
      signature: eventSignature("server_overloaded")
    });
  }

  if (
    /Encountered an unexpected exception|This crash report has been saved to:|Minecraft Crash Report|A crash report has been generated|The game crashed|server crashed|Failed to start the minecraft server|OutOfMemoryError/i.test(message)
    || (level === "FATAL" && /\b(exception|crash|crashed)\b/i.test(message))
  ) {
    return eventFromParsedLine({
      eventType: "server_crashed",
      severity: "error",
      message: "Server crashed",
      details: conciseEventDetails(message),
      timestamp,
      source,
      index,
      signature: eventSignature("server_crashed")
    });
  }

  const exception = message.match(/\b((?:[A-Za-z_$][\w$]*\.)*([A-Za-z_$][\w$]*(?:Exception|Error)))\b(?::\s*(.*))?/i);
  const exceptionContext = /\b(?:caught|caused by|uncaught|unhandled)\b/i.test(message) || ["WARN", "ERROR", "FATAL"].includes(level);
  if (exception && exceptionContext) {
    const exceptionName = exception[2];
    return eventFromParsedLine({
      eventType: "exception_caught",
      severity: level === "WARN" ? "warning" : "error",
      message: `Exception caught: ${exceptionName}`,
      details: conciseEventDetails(message),
      timestamp,
      source,
      index,
      signature: eventSignature("exception_caught", exceptionName),
      subject: exceptionName
    });
  }
  return null;
}

export function eventTimestampSecond(timestamp?: string) {
  if (!timestamp) return "";
  if (/^\d{2}:\d{2}:\d{2}$/.test(timestamp)) return timestamp;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toISOString().slice(0, 19);
}

export function compactRecentEvents(events: ServerEvent[], limit: number) {
  const seen = new Set<string>();
  const compacted: ServerEvent[] = [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    const key = `${event.eventType}:${event.signature}:${eventTimestampSecond(event.timestamp)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    compacted.push(event);
    if (compacted.length >= limit) break;
  }
  return compacted;
}

