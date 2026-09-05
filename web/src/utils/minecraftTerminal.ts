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

export function consumeTerminalTouchScroll(remainder: number, pixelDelta: number, rowHeight: number) {
  const nextRemainder = remainder + pixelDelta;
  if (rowHeight <= 0 || !Number.isFinite(rowHeight)) return { lines: 0, remainder: nextRemainder };
  const lines = Math.trunc(nextRemainder / rowHeight);
  return {
    lines,
    remainder: nextRemainder - lines * rowHeight
  };
}

export function terminalViewportAtBottom(viewportY: number, baseY: number) {
  return viewportY >= baseY;
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

type ConsoleCopyKeystroke = {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/**
 * Whether a keystroke should copy what is selected in the terminal.
 *
 * The terminal draws its own selection, so nothing the browser knows about is selected and its
 * native copy has nothing to act on. The page has to answer the keystroke itself — but only when
 * the terminal is what holds the selection: text selected in the command line, or anywhere else on
 * the page, is the browser's to copy, and a selection of nothing leaves Ctrl+C as the shell key
 * that abandons the command line.
 */
export function shouldCopyTerminalSelection(event: ConsoleCopyKeystroke, selected: {
  terminal: string;
  input: boolean;
  document: string;
}) {
  if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) return false;
  if (event.key.toLowerCase() !== "c") return false;
  return Boolean(selected.terminal) && !selected.input && !selected.document;
}

export function minecraftFormattingToAnsi(text: string) {
  // Copy ordinary text in spans instead of allocating a string for every character of a backlog.
  return text.replace(/[§&]([0-9a-fl-or]|#[0-9a-f]{6})/gi, (_token, code: string) => {
    const normalized = code.toLowerCase();
    if (minecraftAnsiColors[normalized]) return minecraftAnsiColors[normalized];
    if (normalized[0] === "#") {
      const red = Number.parseInt(normalized.slice(1, 3), 16);
      const green = Number.parseInt(normalized.slice(3, 5), 16);
      const blue = Number.parseInt(normalized.slice(5, 7), 16);
      return `\x1b[38;2;${red};${green};${blue}m`;
    }
    return minecraftAnsiStyles[normalized];
  });
}

const minecraftAnsiStyles: Record<string, string> = {
  l: "\x1b[1m", o: "\x1b[3m", n: "\x1b[4m", m: "\x1b[9m", r: "\x1b[0m"
};

/**
 * Turns console lines into what xterm should draw: Minecraft's section codes become ANSI, and bare
 * line feeds become the carriage-return pair a terminal needs to start the next row at column 0.
 *
 * This used to buffer partial lines as well, because it was handed raw stream chunks that could
 * stop mid-line. Lines are framed once now, where the panel numbers them, so everything arriving
 * here is already whole.
 */
export function minecraftLogToTerminalText(text: string) {
  return minecraftFormattingToAnsi(text).replace(/\r?\n/g, "\r\n");
}
