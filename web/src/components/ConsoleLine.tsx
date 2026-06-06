import type { CSSProperties } from "react";

type ConsoleStyle = {
  color?: string;
  fontWeight?: CSSProperties["fontWeight"];
  fontStyle?: CSSProperties["fontStyle"];
  textDecoration?: string;
};

const legacyColors: Record<string, string> = {
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

export function ConsoleLine({ line }: { line: string }) {
  const segments = tokenizeConsoleLine(line);
  return (
    <pre>
      {segments.map((segment, index) => (
        <span key={index} style={segment.style}>{segment.text}</span>
      ))}
    </pre>
  );
}

function tokenizeConsoleLine(line: string) {
  const segments: Array<{ text: string; style: ConsoleStyle }> = [];
  let style: ConsoleStyle = {};
  let buffer = "";

  function flush() {
    if (!buffer) return;
    segments.push({ text: buffer, style: { ...style } });
    buffer = "";
  }

  function resetFormatting(nextColor?: string) {
    style = nextColor ? { color: nextColor } : {};
  }

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const next = line[index + 1]?.toLowerCase();

    if ((char === "&" || char === "\u00a7") && next) {
      if (next === "#" && isHexColor(line.slice(index + 2, index + 8))) {
        flush();
        resetFormatting(`#${line.slice(index + 2, index + 8)}`);
        index += 7;
        continue;
      }
      if (legacyColors[next]) {
        flush();
        resetFormatting(legacyColors[next]);
        index += 1;
        continue;
      }
      if (next === "l") {
        flush();
        style = { ...style, fontWeight: 800 };
        index += 1;
        continue;
      }
      if (next === "o") {
        flush();
        style = { ...style, fontStyle: "italic" };
        index += 1;
        continue;
      }
      if (next === "n" || next === "m") {
        flush();
        const decoration = next === "n" ? "underline" : "line-through";
        style = { ...style, textDecoration: style.textDecoration ? `${style.textDecoration} ${decoration}` : decoration };
        index += 1;
        continue;
      }
      if (next === "r") {
        flush();
        resetFormatting();
        index += 1;
        continue;
      }
    }

    if (char === "#" && isHexColor(line.slice(index + 1, index + 7))) {
      flush();
      resetFormatting(line.slice(index, index + 7));
      index += 6;
      continue;
    }

    if (char === "\u001b" && line[index + 1] === "[") {
      const end = line.indexOf("m", index + 2);
      if (end !== -1) {
        flush();
        applyAnsiCodes(line.slice(index + 2, end).split(";").map(Number), (nextStyle) => {
          style = nextStyle;
        }, style);
        index = end;
        continue;
      }
    }

    buffer += char;
  }

  flush();
  return segments.length ? segments : [{ text: line, style: {} }];
}

function applyAnsiCodes(codes: number[], setStyle: (style: ConsoleStyle) => void, current: ConsoleStyle) {
  let style = { ...current };
  const values = codes.length ? codes : [0];
  for (let index = 0; index < values.length; index += 1) {
    const code = values[index];
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
    else if (code === 38 && values[index + 1] === 2 && values.length >= index + 5) {
      const [red, green, blue] = values.slice(index + 2, index + 5);
      if ([red, green, blue].every((value) => Number.isInteger(value) && value >= 0 && value <= 255)) {
        style.color = `rgb(${red} ${green} ${blue})`;
        index += 4;
      }
    }
  }
  setStyle(style);
}

function addDecoration(current: string | undefined, next: string) {
  if (!current) return next;
  return current.includes(next) ? current : `${current} ${next}`;
}

function isHexColor(value: string) {
  return /^[0-9a-fA-F]{6}$/.test(value);
}
