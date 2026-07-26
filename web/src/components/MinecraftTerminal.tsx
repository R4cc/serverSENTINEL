import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { terminalPreferenceOptions, type ConsoleFontSize, type ConsoleScrollback } from "../features/settings/settingsPreferences";
import {
  consumeTerminalTouchScroll,
  deleteNextTerminalWordAtCursor,
  deletePreviousTerminalWordAtCursor,
  MinecraftLogStreamDecoder,
  nextTerminalWordBoundary,
  previousTerminalWordBoundary,
  recallNextCommand,
  recallPreviousCommand,
  type TerminalHistoryState
} from "../utils/minecraftTerminal";

type MinecraftTerminalProps = {
  entries: string[];
  canSendCommands: boolean;
  disabledReason: string;
  commandHistory: string[];
  fontSize: ConsoleFontSize;
  scrollback: ConsoleScrollback;
  onCommand(command: string): void;
};

type InputSnapshot = {
  value: string;
  cursor: number;
};

type TerminalTheme = ReturnType<typeof terminalTheme>;

const prompt = "\x1b[38;2;112;208;255m>\x1b[0m ";

export function MinecraftTerminal({
  entries,
  canSendCommands,
  disabledReason,
  commandHistory,
  fontSize,
  scrollback,
  onCommand
}: MinecraftTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const initialRenderCompleteRef = useRef(false);
  const previousEntriesRef = useRef<string[]>([]);
  const entriesRef = useRef(entries);
  const logDecoderRef = useRef(new MinecraftLogStreamDecoder());
  const canSendCommandsRef = useRef(canSendCommands);
  const commandHistoryRef = useRef(commandHistory);
  const onCommandRef = useRef(onCommand);
  const inputRef = useRef("");
  const inputCursorRef = useRef(0);
  const undoStackRef = useRef<InputSnapshot[]>([]);
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef("");
  const promptVisibleRef = useRef(false);
  const appliedThemeRef = useRef<TerminalTheme | null>(null);

  entriesRef.current = entries;

  useEffect(() => {
    canSendCommandsRef.current = canSendCommands;
  }, [canSendCommands]);

  useEffect(() => {
    commandHistoryRef.current = commandHistory;
  }, [commandHistory]);

  useEffect(() => {
    onCommandRef.current = onCommand;
  }, [onCommand]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const styles = window.getComputedStyle(container);
    const initialTheme = terminalTheme(styles);
    appliedThemeRef.current = initialTheme;
    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: styles.getPropertyValue("--font-mono") || "ui-monospace, SFMono-Regular, Consolas, monospace",
      lineHeight: 1.35,
      tabStopWidth: 2,
      theme: initialTheme,
      ...terminalPreferenceOptions(fontSize, scrollback)
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const disposables: IDisposable[] = [];

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    let previousTouchY: number | null = null;
    let touchScrollRemainder = 0;
    const handleTouchStart = (event: TouchEvent) => {
      previousTouchY = event.touches.length === 1 ? event.touches[0].clientY : null;
      touchScrollRemainder = 0;
    };
    const handleTouchMove = (event: TouchEvent) => {
      if (previousTouchY === null || event.touches.length !== 1) return;
      const currentTouchY = event.touches[0].clientY;
      const pixelDelta = previousTouchY - currentTouchY;
      previousTouchY = currentTouchY;

      const screen = terminal.element?.querySelector<HTMLElement>(".xterm-screen");
      const rowHeight = screen?.clientHeight ? screen.clientHeight / terminal.rows : 1;
      const scroll = consumeTerminalTouchScroll(touchScrollRemainder, pixelDelta, rowHeight);
      touchScrollRemainder = scroll.remainder;
      if (scroll.lines !== 0) {
        terminal.scrollLines(scroll.lines);
      }

      // xterm's rendered screen is not a native scroll container. Claim the
      // gesture so the page cannot scroll or trigger pull-to-refresh instead.
      if (event.cancelable) event.preventDefault();
    };
    const handleTouchEnd = () => {
      previousTouchY = null;
    };

    container.addEventListener("touchstart", handleTouchStart, { passive: true });
    container.addEventListener("touchmove", handleTouchMove, { passive: false });
    container.addEventListener("touchend", handleTouchEnd, { passive: true });
    container.addEventListener("touchcancel", handleTouchEnd, { passive: true });

    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        // xterm cannot fit while hidden or zero-sized; the next resize will retry.
      }
    };

    const visualViewport = window.visualViewport;
    const keepFocusedPromptVisible = () => {
      if (terminal.textarea !== document.activeElement) return;
      terminal.scrollToBottom();
      if (terminal.element) terminal.element.scrollTop = 0;
    };
    let fitFrame: number | null = null;
    const scheduleFit = () => {
      if (fitFrame !== null) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        fit();
      });
    };
    const handleViewportResize = () => {
      scheduleFit();
      window.requestAnimationFrame(keepFocusedPromptVisible);
    };
    const handleTerminalFocus = () => {
      window.requestAnimationFrame(keepFocusedPromptVisible);
    };

    visualViewport?.addEventListener("resize", handleViewportResize);
    window.addEventListener("resize", handleViewportResize);
    terminal.textarea?.addEventListener("focus", handleTerminalFocus);

    fitFrame = window.requestAnimationFrame(() => {
      fitFrame = null;
      fit();
      initialRenderCompleteRef.current = true;
      writeEntries([], entriesRef.current);
      if (canSendCommandsRef.current) writePrompt();
      terminal.write("", () => {
        if (terminalRef.current !== terminal) return;
        terminal.scrollToBottom();
        container.classList.remove("initializing");
      });
    });

    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(container);

    disposables.push(terminal.onData(handleTerminalData));
    terminal.attachCustomKeyEventHandler(handleTerminalKey);

    return () => {
      if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
      resizeObserver.disconnect();
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
      visualViewport?.removeEventListener("resize", handleViewportResize);
      window.removeEventListener("resize", handleViewportResize);
      terminal.textarea?.removeEventListener("focus", handleTerminalFocus);
      disposables.forEach((disposable) => disposable.dispose());
      fitAddonRef.current = null;
      terminalRef.current = null;
      appliedThemeRef.current = null;
      initialRenderCompleteRef.current = false;
      terminal.dispose();
    };
  }, []);

  // The palette lives in CSS variables, so there is no prop to depend on and this has to
  // re-read the computed style after every render. Assigning `options.theme` is compared by
  // reference inside xterm, so handing it a fresh object rebuilds the colour set and forces a
  // full repaint of every row — at streaming log rates that reads as flicker. Only assign when
  // the resolved colours actually changed.
  useEffect(() => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    if (!container || !terminal) return;
    const nextTheme = terminalTheme(window.getComputedStyle(container));
    if (appliedThemeRef.current && sameTerminalTheme(appliedThemeRef.current, nextTheme)) return;
    appliedThemeRef.current = nextTheme;
    terminal.options.theme = nextTheme;
  });

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !initialRenderCompleteRef.current) return;
    terminal.options.fontSize = fontSize;
    window.requestAnimationFrame(() => {
      try {
        fitAddonRef.current?.fit();
      } catch {
        // xterm cannot fit while hidden or zero-sized; the resize observer will retry.
      }
    });
  }, [fontSize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !initialRenderCompleteRef.current) return;
    terminal.options.scrollback = scrollback;
  }, [scrollback]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !initialRenderCompleteRef.current) return;
    writeEntries(previousEntriesRef.current, entries);
  }, [entries]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !initialRenderCompleteRef.current) return;
    if (canSendCommands) {
      const atBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
      if (!promptVisibleRef.current) writePrompt(atBottom);
      return;
    }
    if (promptVisibleRef.current) {
      clearPromptLine();
      promptVisibleRef.current = false;
      inputRef.current = "";
      inputCursorRef.current = 0;
      undoStackRef.current = [];
      historyIndexRef.current = null;
      historyDraftRef.current = "";
    }
  }, [canSendCommands]);

  function handleTerminalKey(event: KeyboardEvent) {
    if (event.type !== "keydown" || event.altKey || event.metaKey) return true;

    const key = event.key.toLowerCase();
    if (event.ctrlKey && key === "c" && terminalRef.current?.hasSelection()) {
      if (!navigator.clipboard?.writeText) return true;
      void copySelectedText().catch(() => undefined);
      return false;
    }

    if (!canSendCommandsRef.current) return true;

    if (event.key === "Home") {
      setCursor(0);
      return false;
    }

    if (event.key === "End") {
      setCursor(inputRef.current.length);
      return false;
    }

    if (event.key === "Delete") {
      if (event.ctrlKey) deleteNextWord();
      else deleteNextCharacter();
      return false;
    }

    if (!event.ctrlKey) return true;

    if (key === "c") {
      cancelInput();
      return false;
    }

    if (key === "v") {
      return true;
    }

    if (event.key === "Backspace") {
      deletePreviousWord();
      return false;
    }

    if (key === "z") {
      undoInput();
      return false;
    }

    if (event.key === "ArrowLeft") {
      setCursor(previousTerminalWordBoundary(inputRef.current, inputCursorRef.current));
      return false;
    }

    if (event.key === "ArrowRight") {
      setCursor(nextTerminalWordBoundary(inputRef.current, inputCursorRef.current));
      return false;
    }

    return true;
  }

  async function copySelectedText() {
    const selection = terminalRef.current?.getSelection();
    if (!selection) return;
    await navigator.clipboard?.writeText(selection);
  }

  function handleTerminalData(data: string) {
    if (!canSendCommandsRef.current) return;
    if (data === "\r") {
      submitInput();
      return;
    }
    if (data === "\x7f") {
      if (!inputCursorRef.current) return;
      rememberInputForUndo();
      const cursor = inputCursorRef.current;
      inputRef.current = inputRef.current.slice(0, cursor - 1) + inputRef.current.slice(cursor);
      inputCursorRef.current = cursor - 1;
      resetHistoryDraft();
      renderInputLine();
      return;
    }
    if (data === "\x1b[A" || data === "\x1bOA") {
      applyHistoryState(recallPreviousCommand(commandHistoryRef.current, currentHistoryState()));
      return;
    }
    if (data === "\x1b[B" || data === "\x1bOB") {
      applyHistoryState(recallNextCommand(commandHistoryRef.current, currentHistoryState()));
      return;
    }
    if (data === "\x1b[D" || data === "\x1bOD") {
      moveCursor(-1);
      return;
    }
    if (data === "\x1b[C" || data === "\x1bOC") {
      moveCursor(1);
      return;
    }
    if (data.startsWith("\x1b")) return;

    insertPrintableText(data);
  }

  function submitInput() {
    const command = inputRef.current;
    clearPromptLine();
    promptVisibleRef.current = false;
    inputRef.current = "";
    inputCursorRef.current = 0;
    undoStackRef.current = [];
    historyIndexRef.current = null;
    historyDraftRef.current = "";

    const trimmed = command.trim();
    if (trimmed) {
      onCommandRef.current(trimmed);
      if (canSendCommandsRef.current) writePrompt();
      return;
    }
    if (canSendCommandsRef.current) writePrompt();
  }

  function insertPrintableText(data: string) {
    const printable = [...data].filter((char) => char >= " " && char !== "\x7f").join("");
    if (!printable) return;
    rememberInputForUndo();
    const cursor = inputCursorRef.current;
    inputRef.current = inputRef.current.slice(0, cursor) + printable + inputRef.current.slice(cursor);
    inputCursorRef.current = cursor + printable.length;
    resetHistoryDraft();
    renderInputLine();
  }

  function deletePreviousWord() {
    const nextState = deletePreviousTerminalWordAtCursor(inputRef.current, inputCursorRef.current);
    if (nextState.value === inputRef.current) return;
    rememberInputForUndo();
    inputRef.current = nextState.value;
    inputCursorRef.current = nextState.cursor;
    resetHistoryDraft();
    renderInputLine();
  }

  function deleteNextWord() {
    const nextState = deleteNextTerminalWordAtCursor(inputRef.current, inputCursorRef.current);
    if (nextState.value === inputRef.current) return;
    rememberInputForUndo();
    inputRef.current = nextState.value;
    resetHistoryDraft();
    renderInputLine();
  }

  function deleteNextCharacter() {
    const cursor = inputCursorRef.current;
    if (cursor >= inputRef.current.length) return;
    rememberInputForUndo();
    inputRef.current = inputRef.current.slice(0, cursor) + inputRef.current.slice(cursor + 1);
    resetHistoryDraft();
    renderInputLine();
  }

  function rememberInputForUndo() {
    undoStackRef.current = [
      ...undoStackRef.current.slice(-99),
      { value: inputRef.current, cursor: inputCursorRef.current }
    ];
  }

  function undoInput() {
    const snapshot = undoStackRef.current.pop();
    if (!snapshot) return;
    inputRef.current = snapshot.value;
    inputCursorRef.current = snapshot.cursor;
    resetHistoryDraft();
    renderInputLine();
  }

  function moveCursor(direction: -1 | 1) {
    setCursor(inputCursorRef.current + direction);
  }

  function setCursor(cursor: number) {
    const nextCursor = Math.max(0, Math.min(inputRef.current.length, cursor));
    if (nextCursor === inputCursorRef.current) return;
    inputCursorRef.current = nextCursor;
    renderInputLine();
  }

  function cancelInput() {
    if (!terminalRef.current) return;
    terminalRef.current.write(`\r\x1b[2K${inputRef.current}^C\r\n`);
    promptVisibleRef.current = false;
    inputRef.current = "";
    inputCursorRef.current = 0;
    undoStackRef.current = [];
    resetHistoryDraft();
    writePrompt();
  }

  function resetHistoryDraft() {
    historyIndexRef.current = null;
    historyDraftRef.current = "";
  }

  function currentHistoryState(): TerminalHistoryState {
    return {
      value: inputRef.current,
      historyIndex: historyIndexRef.current,
      draft: historyDraftRef.current
    };
  }

  function applyHistoryState(state: TerminalHistoryState) {
    inputRef.current = state.value;
    inputCursorRef.current = state.value.length;
    historyIndexRef.current = state.historyIndex;
    historyDraftRef.current = state.draft;
    renderInputLine();
  }

  function writeEntries(previousEntries: string[], nextEntries: string[]) {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const diff = diffEntries(previousEntries, nextEntries);
    const chunks = diff.chunks;
    if (!chunks.length && !diff.reset) {
      previousEntriesRef.current = nextEntries;
      return;
    }

    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    if (diff.reset) {
      terminal.reset();
      logDecoderRef.current.reset();
      promptVisibleRef.current = false;
    } else if (promptVisibleRef.current) {
      clearPromptLine();
      promptVisibleRef.current = false;
    }

    // The decoder carries its partial line across calls, so joining first and writing once is
    // equivalent to writing each entry — and it keeps a snapshot of thousands of lines to a
    // single parser pass instead of one queued write per line.
    writeLogChunk(chunks.join(""));
    previousEntriesRef.current = nextEntries;

    // Reading a log line is not a reason to yank someone who scrolled up back to the newest
    // output; only follow the tail when they were already pinned to it.
    if (canSendCommandsRef.current) writePrompt(wasAtBottom);
    if (wasAtBottom) terminal.scrollToBottom();
  }

  function writeLogChunk(chunk: string) {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const decoded = logDecoderRef.current.write(chunk);
    if (decoded) terminal.write(decoded);
  }

  function writePrompt(followTail = true) {
    if (promptVisibleRef.current || !terminalRef.current) return;
    terminalRef.current.write(`${prompt}${inputRef.current}`);
    positionCursorAfterRender();
    if (followTail) terminalRef.current.scrollToBottom();
    promptVisibleRef.current = true;
  }

  function clearPromptLine() {
    terminalRef.current?.write("\r\x1b[2K");
  }

  function renderInputLine() {
    if (!terminalRef.current) return;
    promptVisibleRef.current = true;
    terminalRef.current.write(`\r\x1b[2K${prompt}${inputRef.current}`);
    positionCursorAfterRender();
    terminalRef.current.scrollToBottom();
  }

  function positionCursorAfterRender() {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const charactersAfterCursor = inputRef.current.length - inputCursorRef.current;
    if (charactersAfterCursor) terminal.write(`\x1b[${charactersAfterCursor}D`);
  }

  return (
    <div className={`minecraftTerminalShell ${canSendCommands ? "" : "disabled"}`}>
      <div ref={containerRef} className="minecraftTerminal initializing" aria-label="Minecraft server console" />
      {!canSendCommands && (
        <div className="minecraftTerminalStatus">
          {disabledReason || "Console command input is unavailable."}
        </div>
      )}
    </div>
  );
}

function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string) {
  return styles.getPropertyValue(name).trim() || fallback;
}

function terminalTheme(styles: CSSStyleDeclaration) {
  return {
    background: cssVar(styles, "--terminal-bg", "#17191e"),
    foreground: cssVar(styles, "--terminal-text", "#dfe3eb"),
    cursor: cssVar(styles, "--sentinel-accent-muted", "#70d0ff"),
    selectionBackground: "rgba(112, 208, 255, 0.28)"
  };
}

function sameTerminalTheme(left: TerminalTheme, right: TerminalTheme) {
  return left.background === right.background
    && left.foreground === right.foreground
    && left.cursor === right.cursor
    && left.selectionBackground === right.selectionBackground;
}

/**
 * Finds how many trailing entries of `previousEntries` line up with the leading entries of
 * `nextEntries`. Once the scrollback limit trims the head of the buffer, every update arrives
 * shifted rather than appended, so this runs on every streamed line and has to stay allocation
 * free — slicing candidate windows here is what made large consoles stutter.
 */
function trailingOverlap(previousEntries: string[], nextEntries: string[]) {
  const maxOverlap = Math.min(previousEntries.length, nextEntries.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const offset = previousEntries.length - overlap;
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (previousEntries[offset + index] !== nextEntries[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return overlap;
  }
  return 0;
}

function diffEntries(previousEntries: string[], nextEntries: string[]) {
  const appendOnly = previousEntries.length <= nextEntries.length
    && previousEntries.every((entry, index) => entry === nextEntries[index]);
  if (appendOnly) return { reset: false, chunks: nextEntries.slice(previousEntries.length) };
  if (!nextEntries.length) return { reset: true, chunks: [] };

  const overlap = trailingOverlap(previousEntries, nextEntries);
  if (overlap > 0) return { reset: false, chunks: nextEntries.slice(overlap) };

  return { reset: true, chunks: nextEntries };
}
