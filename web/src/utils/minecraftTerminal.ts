export type TerminalHistoryState = {
  value: string;
  historyIndex: number | null;
  draft: string;
};

const minecraftAnsiColors: Record<string, string> = {
  "0": "\x1b[38;2;0;0;0m",
  "1": "\x1b[38;2;0;0;170m",
  "2": "\x1b[38;2;0;170;0m",
  "3": "\x1b[38;2;0;170;170m",
  "4": "\x1b[38;2;170;0;0m",
  "5": "\x1b[38;2;170;0;170m",
  "6": "\x1b[38;2;255;170;0m",
  "7": "\x1b[38;2;170;170;170m",
  "8": "\x1b[38;2;85;85;85m",
  "9": "\x1b[38;2;85;85;255m",
  a: "\x1b[38;2;85;255;85m",
  b: "\x1b[38;2;85;255;255m",
  c: "\x1b[38;2;255;85;85m",
  d: "\x1b[38;2;255;85;255m",
  e: "\x1b[38;2;255;255;85m",
  f: "\x1b[38;2;255;255;255m"
};

export function appendCommandHistory(history: string[], command: string) {
  const normalized = command.trim().replace(/^\//, "");
  if (!normalized) return history;
  return [...history.filter((entry) => entry !== normalized), normalized].slice(-50);
}

export function deletePreviousTerminalWord(value: string) {
  return deletePreviousTerminalWordAtCursor(value, value.length).value;
}

export function deletePreviousTerminalWordAtCursor(value: string, cursor: number) {
  const beforeCursor = value.slice(0, cursor);
  const afterCursor = value.slice(cursor);
  const retainedBeforeCursor = beforeCursor.replace(/\s+$/, "").replace(/\S+$/, "");
  return {
    value: retainedBeforeCursor + afterCursor,
    cursor: retainedBeforeCursor.length
  };
}

export function recallPreviousCommand(history: string[], state: TerminalHistoryState): TerminalHistoryState {
  if (!history.length) return state;
  const historyIndex = state.historyIndex === null ? history.length - 1 : Math.max(0, state.historyIndex - 1);
  return {
    value: history[historyIndex],
    historyIndex,
    draft: state.historyIndex === null ? state.value : state.draft
  };
}

export function recallNextCommand(history: string[], state: TerminalHistoryState): TerminalHistoryState {
  if (state.historyIndex === null) return state;
  const historyIndex = state.historyIndex + 1;
  if (historyIndex >= history.length) {
    return {
      value: state.draft,
      historyIndex: null,
      draft: ""
    };
  }
  return {
    value: history[historyIndex],
    historyIndex,
    draft: state.draft
  };
}

export function minecraftFormattingToAnsi(text: string) {
  let output = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== "\u00a7" && char !== "&") {
      output += char;
      continue;
    }

    const next = text[index + 1]?.toLowerCase();
    if (!next) {
      output += char;
      continue;
    }

    if (minecraftAnsiColors[next]) {
      output += minecraftAnsiColors[next];
      index += 1;
      continue;
    }
    if (next === "l") {
      output += "\x1b[1m";
      index += 1;
      continue;
    }
    if (next === "o") {
      output += "\x1b[3m";
      index += 1;
      continue;
    }
    if (next === "n") {
      output += "\x1b[4m";
      index += 1;
      continue;
    }
    if (next === "m") {
      output += "\x1b[9m";
      index += 1;
      continue;
    }
    if (next === "r") {
      output += "\x1b[0m";
      index += 1;
      continue;
    }
    if (next === "#" && isHexColor(text.slice(index + 2, index + 8))) {
      const red = Number.parseInt(text.slice(index + 2, index + 4), 16);
      const green = Number.parseInt(text.slice(index + 4, index + 6), 16);
      const blue = Number.parseInt(text.slice(index + 6, index + 8), 16);
      output += `\x1b[38;2;${red};${green};${blue}m`;
      index += 7;
      continue;
    }

    output += char;
  }
  return output;
}

function isHexColor(value: string) {
  return /^[0-9a-fA-F]{6}$/.test(value);
}
