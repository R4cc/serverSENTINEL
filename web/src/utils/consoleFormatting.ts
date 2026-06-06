import type { CSSProperties } from "react";

export type ConsoleTextStyle = {
  color?: string;
  fontWeight?: CSSProperties["fontWeight"];
  fontStyle?: CSSProperties["fontStyle"];
  textDecoration?: string;
};

export type ConsoleSegment = {
  text: string;
  style: ConsoleTextStyle;
};

type ParserState = {
  style: ConsoleTextStyle;
  pending: string;
};

const minecraftColors: Record<string, string> = {
  "0": "#000000",
  "1": "#0000aa",
  "2": "#00aa00",
  "3": "#00aaaa",
  "4": "#aa0000",
  "5": "#aa00aa",
  "6": "#ffaa00",
  "7": "#aaaaaa",
  "8": "#555555",
  "9": "#5555ff",
  a: "#55ff55",
  b: "#55ffff",
  c: "#ff5555",
  d: "#ff55ff",
  e: "#ffff55",
  f: "#ffffff"
};

const ansiColors: Record<number, string> = {
  30: "#000000",
  31: "#ff5555",
  32: "#55ff55",
  33: "#ffff55",
  34: "#5555ff",
  35: "#ff55ff",
  36: "#55ffff",
  37: "#ffffff",
  90: "#555555",
  91: "#ff7777",
  92: "#77ff77",
  93: "#ffff77",
  94: "#7777ff",
  95: "#ff77ff",
  96: "#77ffff",
  97: "#ffffff"
};

export function parseConsoleText(chunks: string[]) {
  const state: ParserState = { style: {}, pending: "" };
  const lines: ConsoleSegment[][] = [];
  let currentLine: ConsoleSegment[] = [];

  for (const chunk of chunks) {
    for (const segment of parseConsoleChunk(chunk, state, false)) {
      const parts = segment.text.split(/\n/);
      for (let index = 0; index < parts.length; index += 1) {
        if (index > 0) {
          lines.push(currentLine);
          currentLine = [];
        }
        if (parts[index]) {
          currentLine.push({ text: parts[index].replace(/\r/g, ""), style: segment.style });
        }
      }
    }
  }

  lines.push(currentLine);
  return lines;
}

export function stripConsoleFormatting(text: string) {
  return parseConsoleChunk(text, { style: {}, pending: "" }, false).map((segment) => segment.text).join("");
}

function parseConsoleChunk(chunk: string, state: ParserState, flushPending: boolean) {
  const segments: ConsoleSegment[] = [];
  let text = state.pending + chunk;
  state.pending = "";
  let buffer = "";

  function flush() {
    if (!buffer) return;
    segments.push({ text: buffer, style: { ...state.style } });
    buffer = "";
  }

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if ((char === "&" || char === "\u00a7") && index + 1 >= text.length && !flushPending) {
      state.pending = text.slice(index);
      break;
    }

    if (char === "&" || char === "\u00a7") {
      const next = text[index + 1]?.toLowerCase();
      const hexStart = next === "#" ? index + 2 : index + 1;
      if (next === "#" && hexStart + 6 > text.length && !flushPending) {
        state.pending = text.slice(index);
        break;
      }
      if (next === "#" && isHexColor(text.slice(hexStart, hexStart + 6))) {
        flush();
        state.style = { color: `#${text.slice(hexStart, hexStart + 6)}` };
        index += 7;
        continue;
      }
      if (minecraftColors[next]) {
        flush();
        state.style = { color: minecraftColors[next] };
        index += 1;
        continue;
      }
      if (next === "l") {
        flush();
        state.style = { ...state.style, fontWeight: 800 };
        index += 1;
        continue;
      }
      if (next === "o") {
        flush();
        state.style = { ...state.style, fontStyle: "italic" };
        index += 1;
        continue;
      }
      if (next === "n" || next === "m") {
        flush();
        const decoration = next === "n" ? "underline" : "line-through";
        state.style = { ...state.style, textDecoration: addDecoration(state.style.textDecoration, decoration) };
        index += 1;
        continue;
      }
      if (next === "r") {
        flush();
        state.style = {};
        index += 1;
        continue;
      }
    }

    if (char === "\u001b") {
      const parsed = parseAnsiSequence(text, index, !flushPending);
      if (parsed.incomplete) {
        state.pending = text.slice(index);
        break;
      }
      if (parsed.endIndex !== undefined) {
        flush();
        state.style = applyAnsiCodes(parsed.codes, state.style);
        index = parsed.endIndex;
        continue;
      }
    }

    buffer += char;
  }

  if (flushPending && state.pending) {
    buffer += state.pending;
    state.pending = "";
  }

  flush();
  return segments;
}

function parseAnsiSequence(text: string, start: number, allowIncomplete: boolean) {
  if (text[start + 1] !== "[") return {};
  let index = start + 2;
  while (index < text.length && /[0-9;]/.test(text[index])) index += 1;
  if (index >= text.length) return allowIncomplete ? { incomplete: true } : {};
  if (text[index] !== "m") return {};
  const rawCodes = text.slice(start + 2, index);
  return {
    codes: rawCodes ? rawCodes.split(";").map((part) => Number(part || 0)) : [0],
    endIndex: index
  };
}

function applyAnsiCodes(codes: number[] | undefined, current: ConsoleTextStyle) {
  let style = { ...current };
  for (let index = 0; index < (codes ?? [0]).length; index += 1) {
    const code = codes?.[index] ?? 0;
    if (code === 0) style = {};
    else if (code === 1) style.fontWeight = 800;
    else if (code === 3) style.fontStyle = "italic";
    else if (code === 4) style.textDecoration = addDecoration(style.textDecoration, "underline");
    else if (code === 9) style.textDecoration = addDecoration(style.textDecoration, "line-through");
    else if (ansiColors[code]) style.color = ansiColors[code];
    else if (code === 39) delete style.color;
    else if (code === 22) delete style.fontWeight;
    else if (code === 23) delete style.fontStyle;
    else if (code === 24 || code === 29) delete style.textDecoration;
    else if (code === 38 && codes?.[index + 1] === 2 && codes.length >= index + 5) {
      const [red, green, blue] = codes.slice(index + 2, index + 5);
      if ([red, green, blue].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
        style.color = `rgb(${red} ${green} ${blue})`;
        index += 4;
      }
    }
  }
  return style;
}

function addDecoration(current: string | undefined, next: string) {
  if (!current) return next;
  return current.includes(next) ? current : `${current} ${next}`;
}

function isHexColor(value: string) {
  return /^[0-9a-fA-F]{6}$/.test(value);
}
