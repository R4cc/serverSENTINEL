export type ConsoleChatKind = "chat" | "emote" | "server" | "system";

export type ConsoleChatEntry = {
  id: string;
  kind: ConsoleChatKind;
  /** Player the entry belongs to, or "" for server and unattributed lines. */
  player: string;
  text: string;
  /** Wall time exactly as the log reported it, or "" when the line carried none. */
  time: string;
  /** Minutes since midnight for gap detection, or null when the line carried no time. */
  dayMinutes: number | null;
  /** Broadcasts that originate from the server itself render on the operator side. */
  outgoing: boolean;
  /** Rank or channel tag a chat plugin printed ahead of the name, or "" when absent. */
  rank: string;
};

export type ConsoleChatTimelineItem =
  | { type: "separator"; id: string; label: string }
  | { type: "system"; id: string; entry: ConsoleChatEntry }
  | { type: "cluster"; id: string; player: string; rank: string; outgoing: boolean; entries: ConsoleChatEntry[] };

export const consoleChatHistoryLimit = 500;
const clusterGapMinutes = 5;
const separatorGapMinutes = 10;

const ansiPattern = /\u001b\[[0-9;]*m/g;
const sectionFormattingPattern = /§(?:#[0-9a-fA-F]{6}|[0-9a-fk-orA-FK-OR])/g;
const chatPattern = /^<([^>]{1,48})>\s?([\s\S]*)$/;
// Chat plugins print a rank or channel ahead of the name, either as
// "[ADM] Steve : hi" or "[ADM] <Steve> hi".
const rankBracketChatPattern = /^\[([^\]]{1,24})\]\s+<([^>]{1,48})>\s?([\s\S]*)$/;
const rankChatPattern = /^\[([^\]]{1,24})\]\s+([A-Za-z0-9_.]{1,32})\s*:\s+([\s\S]+)$/;
// Rank-less plugins print "Steve : hi". The spaced colon is what separates this
// from ordinary log payloads such as "Mismatch in destroy block pos: ...".
const spacedChatPattern = /^([A-Za-z0-9_.]{1,32})\s+:\s+([\s\S]+)$/;
const emotePattern = /^\*\s+(\S{1,32})\s+([\s\S]+)$/;
const serverSayPattern = /^\[Server\]\s?([\s\S]*)$/;
const joinPattern = /^(.{1,48}?) joined the game$/i;
const leavePattern = /^(.{1,48}?) left the game$/i;
const advancementPattern = /^(.{1,48}?) has (made the advancement|completed the challenge|reached the goal) (\[[^\]]+\])$/i;
const commandPattern = /^(.{1,48}?) issued server command: (\/[\s\S]+)$/;

// Vanilla death notices are player-facing chat, but their phrasings are too
// varied to detect generically without swallowing ordinary log lines, so the
// verb phrase is matched explicitly.
const deathPattern = new RegExp(`^([A-Za-z0-9_.]{1,32}) (${[
  "was (?:slain|shot|killed|fireballed|pummelled|squashed|impaled|skewered|stung|poked|struck)\\b.*",
  "was (?:blown up|doomed to fall|squished too much|pricked to death|burnt to a crisp|roasted in dragon('s)? breath|obliterated by a sonically[- ]charged shriek)\\b.*",
  "(?:drowned|starved to death|suffocated in a wall|withered away|blew up|died|froze to death)(?: .*)?",
  "(?:hit the ground too hard|fell (?:off|from|out of|into|while)\\b.*|fell from a high place)",
  "(?:burned to death|went up in flames|discovered the floor was lava|walked into (?:fire|danger|the danger zone)\\b.*)",
  "(?:tried to swim in lava|experienced kinetic energy|left the confines of this world|didn't want to live in the same world as .*)",
  "(?:was killed (?:by|while|trying)\\b.*|went off with a bang.*|was squashed by .*|was impaled on a stalagmite.*)"
].join("|")})$`);

/** Strips ANSI colouring and Minecraft section formatting so matching sees plain text. */
export function stripConsoleFormatting(line: string) {
  return line.replace(ansiPattern, "").replace(sectionFormattingPattern, "");
}

function cleanPlayerName(value: string) {
  return value.trim().replace(/^"|"$/g, "").replace(/\s+\(\/?[^)]+:\d+\)$/, "");
}

function isPlayerName(value: string) {
  return /^[A-Za-z0-9_.]{1,32}$/.test(value);
}

type ParsedLogLine = {
  time: string;
  dayMinutes: number | null;
  level: string;
  message: string;
};

/** Splits a Minecraft log line into its timestamp, level, and message payload. */
export function splitConsoleLogLine(line: string): ParsedLogLine | null {
  const plain = stripConsoleFormatting(line).trim();
  if (!plain) return null;

  let time = "";
  let dayMinutes: number | null = null;
  let rest = plain;

  const timestamp = plain.match(/^\[(?<stamp>\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?|\d{2}:\d{2}:\d{2})\]/);
  if (timestamp) {
    const stamp = timestamp.groups!.stamp;
    const clock = stamp.match(/(\d{2}):(\d{2}):\d{2}/);
    if (clock) {
      time = `${clock[1]}:${clock[2]}`;
      dayMinutes = Number(clock[1]) * 60 + Number(clock[2]);
    }
    rest = plain.slice(timestamp[0].length).trim();
  }

  let level = "";
  let message = rest;
  // Loggers such as [minecraft/MinecraftServer] may sit between the level and the payload.
  const modern = rest.match(/^\[(?<thread>[^\]/]+)\/(?<level>[A-Z]+)\](?:\s*\[[^\]]+\])*:\s*(?<message>[\s\S]*)$/);
  const bracketed = modern ? null : rest.match(/^\[(?<thread>[^\]]+)\]\s+\[(?<level>[A-Z]+)\](?:\s*\[[^\]]+\])*:\s*(?<message>[\s\S]*)$/);
  const levelOnly = modern || bracketed ? null : rest.match(/^\[(?<level>[A-Z]+)\]:\s*(?<message>[\s\S]*)$/);
  const plainLevel = modern || bracketed || levelOnly ? null : rest.match(/^(?<level>[A-Z]+):\s*(?<message>[\s\S]*)$/);
  const matched = modern ?? bracketed ?? levelOnly ?? plainLevel;
  if (matched) {
    level = matched.groups!.level;
    message = matched.groups!.message;
  }

  message = message.replace(/^\[Not Secure\]\s*/i, "").trim();

  return { time, dayMinutes, level, message };
}

/**
 * Turns one console line into a chat entry. Lines that carry no player-facing
 * conversation return null so the transcript stays readable.
 */
export function parseConsoleChatLine(line: string, id: string): ConsoleChatEntry | null {
  const parsed = splitConsoleLogLine(line);
  if (!parsed) return null;
  if (parsed.level && parsed.level !== "INFO") return null;

  const message = parsed.message;
  if (!message) return null;

  const base = { id, time: parsed.time, dayMinutes: parsed.dayMinutes, rank: "" };

  const say = message.match(serverSayPattern);
  if (say && say[1].trim()) {
    return { ...base, kind: "server", player: "", text: say[1].trim(), outgoing: true };
  }

  const chat = message.match(chatPattern);
  if (chat) {
    const player = cleanPlayerName(chat[1]);
    if (isPlayerName(player)) {
      return { ...base, kind: "chat", player, text: chat[2].trim(), outgoing: false };
    }
  }

  const rankBracketChat = message.match(rankBracketChatPattern);
  if (rankBracketChat) {
    const player = cleanPlayerName(rankBracketChat[2]);
    if (isPlayerName(player)) {
      return { ...base, kind: "chat", player, rank: rankBracketChat[1].trim(), text: rankBracketChat[3].trim(), outgoing: false };
    }
  }

  const rankChat = message.match(rankChatPattern);
  if (rankChat) {
    return { ...base, kind: "chat", player: rankChat[2], rank: rankChat[1].trim(), text: rankChat[3].trim(), outgoing: false };
  }

  const spacedChat = message.match(spacedChatPattern);
  if (spacedChat) {
    return { ...base, kind: "chat", player: spacedChat[1], text: spacedChat[2].trim(), outgoing: false };
  }

  const emote = message.match(emotePattern);
  if (emote && isPlayerName(emote[1])) {
    return { ...base, kind: "emote", player: emote[1], text: emote[2].trim(), outgoing: false };
  }

  const joined = message.match(joinPattern);
  if (joined) {
    const player = cleanPlayerName(joined[1]);
    if (isPlayerName(player)) return { ...base, kind: "system", player, text: `${player} joined the game`, outgoing: false };
  }

  const left = message.match(leavePattern);
  if (left) {
    const player = cleanPlayerName(left[1]);
    if (isPlayerName(player)) return { ...base, kind: "system", player, text: `${player} left the game`, outgoing: false };
  }

  const advancement = message.match(advancementPattern);
  if (advancement) {
    const player = cleanPlayerName(advancement[1]);
    if (isPlayerName(player)) {
      return { ...base, kind: "system", player, text: `${player} ${advancement[2].toLowerCase()} ${advancement[3]}`, outgoing: false };
    }
  }

  const command = message.match(commandPattern);
  if (command) {
    const player = cleanPlayerName(command[1]);
    if (isPlayerName(player)) return { ...base, kind: "system", player, text: `${player} ran ${command[2]}`, outgoing: false };
  }

  const death = message.match(deathPattern);
  if (death) {
    return { ...base, kind: "system", player: death[1], text: message, outgoing: false };
  }

  return null;
}

/**
 * Consumes console chunks the same way the terminal does: partial trailing lines
 * are buffered until their newline arrives, so a split write never mis-parses.
 */
export class ConsoleChatStream {
  private pending = "";
  private sequence = 0;

  write(chunk: string): ConsoleChatEntry[] {
    const text = this.pending + chunk;
    const lastLineFeed = text.lastIndexOf("\n");
    if (lastLineFeed === -1) {
      this.pending = text;
      return [];
    }

    this.pending = text.slice(lastLineFeed + 1);
    const entries: ConsoleChatEntry[] = [];
    for (const line of text.slice(0, lastLineFeed).split(/\r?\n/)) {
      const id = `chat-${this.sequence}`;
      this.sequence += 1;
      const entry = parseConsoleChatLine(line, id);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  writeAll(chunks: string[]): ConsoleChatEntry[] {
    return chunks.flatMap((chunk) => this.write(chunk));
  }

  reset() {
    this.pending = "";
    this.sequence = 0;
  }
}

/** Convenience wrapper for parsing a complete console buffer in one pass. */
export function consoleChatEntries(chunks: string[], limit = consoleChatHistoryLimit) {
  return new ConsoleChatStream().writeAll(chunks).slice(-limit);
}

function forwardGapMinutes(previous: number, next: number) {
  const gap = next - previous;
  return gap < 0 ? gap + 24 * 60 : gap;
}

function needsSeparator(previous: ConsoleChatEntry | undefined, entry: ConsoleChatEntry) {
  if (!entry.time) return false;
  if (!previous) return true;
  if (previous.dayMinutes === null || entry.dayMinutes === null) return false;
  return forwardGapMinutes(previous.dayMinutes, entry.dayMinutes) >= separatorGapMinutes;
}

function continuesCluster(previous: ConsoleChatEntry, entry: ConsoleChatEntry) {
  if (previous.kind === "system" || entry.kind === "system") return false;
  if (previous.player !== entry.player || previous.outgoing !== entry.outgoing) return false;
  if (previous.dayMinutes === null || entry.dayMinutes === null) return true;
  return forwardGapMinutes(previous.dayMinutes, entry.dayMinutes) < clusterGapMinutes;
}

/**
 * Groups consecutive messages from one author into a single bubble stack and
 * inserts a time separator whenever the conversation pauses.
 */
export function consoleChatTimeline(entries: ConsoleChatEntry[]): ConsoleChatTimelineItem[] {
  const items: ConsoleChatTimelineItem[] = [];
  let previous: ConsoleChatEntry | undefined;

  for (const entry of entries) {
    if (needsSeparator(previous, entry)) {
      items.push({ type: "separator", id: `${entry.id}-separator`, label: entry.time });
      previous = undefined;
    }

    if (entry.kind === "system") {
      items.push({ type: "system", id: entry.id, entry });
      previous = entry;
      continue;
    }

    const last = items.at(-1);
    if (last?.type === "cluster" && previous && continuesCluster(previous, entry)) {
      last.entries.push(entry);
      // A promotion mid-stack should show the rank the player holds now.
      if (entry.rank) last.rank = entry.rank;
    } else {
      items.push({ type: "cluster", id: entry.id, player: entry.player, rank: entry.rank, outgoing: entry.outgoing, entries: [entry] });
    }
    previous = entry;
  }

  return items;
}

export const consoleChatToneCount = 8;

/** Stable per-player colour bucket so each participant keeps one identity colour. */
export function consoleChatTone(player: string) {
  let hash = 0;
  for (const char of player.toLowerCase()) hash = (hash * 31 + char.charCodeAt(0)) % 100_003;
  return hash % consoleChatToneCount;
}

export function consoleChatInitials(player: string) {
  const cleaned = player.replace(/[^A-Za-z0-9]/g, "");
  if (!cleaned) return "?";
  const uppercase = cleaned.match(/[A-Z0-9]/g);
  if (uppercase && uppercase.length >= 2) return `${uppercase[0]}${uppercase[1]}`;
  return cleaned.slice(0, 2).toUpperCase();
}

/** Chat input starting with a slash is a raw command; anything else is broadcast. */
export function consoleChatCommand(message: string) {
  const trimmed = message.trim();
  if (!trimmed) return "";
  return trimmed.startsWith("/") ? trimmed.slice(1).trim() : `say ${trimmed}`;
}
