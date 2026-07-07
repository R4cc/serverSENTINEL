import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import type { IDisposable } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  deletePreviousTerminalWord,
  minecraftFormattingToAnsi,
  recallNextCommand,
  recallPreviousCommand,
  type TerminalHistoryState
} from "../utils/minecraftTerminal";

type MinecraftTerminalProps = {
  entries: string[];
  canSendCommands: boolean;
  disabledReason: string;
  commandHistory: string[];
  onCommand(command: string): void;
};

const prompt = "\x1b[38;2;112;208;255m>\x1b[0m ";

export function MinecraftTerminal({
  entries,
  canSendCommands,
  disabledReason,
  commandHistory,
  onCommand
}: MinecraftTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const previousEntriesRef = useRef<string[]>([]);
  const canSendCommandsRef = useRef(canSendCommands);
  const commandHistoryRef = useRef(commandHistory);
  const onCommandRef = useRef(onCommand);
  const inputRef = useRef("");
  const historyIndexRef = useRef<number | null>(null);
  const historyDraftRef = useRef("");
  const promptVisibleRef = useRef(false);

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
    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: styles.getPropertyValue("--font-mono") || "ui-monospace, SFMono-Regular, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.35,
      scrollback: 5000,
      tabStopWidth: 2,
      theme: terminalTheme(styles)
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    const disposables: IDisposable[] = [];

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(container);
    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        // xterm cannot fit while hidden or zero-sized; the next resize will retry.
      }
    };

    window.requestAnimationFrame(() => {
      fit();
      writeEntries([], entries);
      if (canSendCommandsRef.current) writePrompt();
    });

    const resizeObserver = new ResizeObserver(() => fit());
    resizeObserver.observe(container);

    disposables.push(terminal.onData(handleTerminalData));
    terminal.attachCustomKeyEventHandler(handleTerminalKey);

    return () => {
      resizeObserver.disconnect();
      disposables.forEach((disposable) => disposable.dispose());
      fitAddonRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
  }, []);

  useEffect(() => {
    const container = containerRef.current;
    const terminal = terminalRef.current;
    if (!container || !terminal) return;
    terminal.options.theme = terminalTheme(window.getComputedStyle(container));
  });

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    writeEntries(previousEntriesRef.current, entries);
  }, [entries]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (canSendCommands) {
      if (!promptVisibleRef.current) writePrompt();
      return;
    }
    if (promptVisibleRef.current) {
      clearPromptLine();
      promptVisibleRef.current = false;
      inputRef.current = "";
      historyIndexRef.current = null;
      historyDraftRef.current = "";
    }
  }, [canSendCommands]);

  function handleTerminalKey(event: KeyboardEvent) {
    if (event.type !== "keydown" || !event.ctrlKey || event.altKey || event.metaKey) return true;

    const key = event.key.toLowerCase();
    if (key === "c") {
      if (terminalRef.current?.hasSelection()) {
        if (!navigator.clipboard?.writeText) return true;
        void copySelectedText().catch(() => undefined);
        return false;
      }
      if (!canSendCommandsRef.current) return true;
      cancelInput();
      return false;
    }

    if (key === "v") {
      if (!canSendCommandsRef.current || !navigator.clipboard?.readText) return true;
      void pasteClipboardText().catch(() => undefined);
      return false;
    }

    if (event.key === "Backspace") {
      if (canSendCommandsRef.current) deletePreviousWord();
      return false;
    }

    return true;
  }

  async function copySelectedText() {
    const selection = terminalRef.current?.getSelection();
    if (!selection) return;
    await navigator.clipboard?.writeText(selection);
  }

  async function pasteClipboardText() {
    const text = await navigator.clipboard?.readText();
    if (!text) return;
    insertPrintableText(text);
  }

  function handleTerminalData(data: string) {
    if (!canSendCommandsRef.current) return;
    if (data === "\r") {
      submitInput();
      return;
    }
    if (data === "\x7f") {
      if (!inputRef.current) return;
      inputRef.current = inputRef.current.slice(0, -1);
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
    if (data.startsWith("\x1b")) return;

    insertPrintableText(data);
  }

  function submitInput() {
    const command = inputRef.current;
    terminalRef.current?.write(`\r\x1b[2K${command}\r\n`);
    promptVisibleRef.current = false;
    inputRef.current = "";
    historyIndexRef.current = null;
    historyDraftRef.current = "";

    const trimmed = command.trim();
    if (trimmed) {
      onCommandRef.current(trimmed);
      return;
    }
    if (canSendCommandsRef.current) writePrompt();
  }

  function insertPrintableText(data: string) {
    const printable = [...data].filter((char) => char >= " " && char !== "\x7f").join("");
    if (!printable) return;
    inputRef.current += printable;
    resetHistoryDraft();
    renderInputLine();
  }

  function deletePreviousWord() {
    const nextInput = deletePreviousTerminalWord(inputRef.current);
    if (nextInput === inputRef.current) return;
    inputRef.current = nextInput;
    resetHistoryDraft();
    renderInputLine();
  }

  function cancelInput() {
    if (!terminalRef.current) return;
    terminalRef.current.write(`\r\x1b[2K${inputRef.current}^C\r\n`);
    promptVisibleRef.current = false;
    inputRef.current = "";
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
      promptVisibleRef.current = false;
    } else if (promptVisibleRef.current) {
      clearPromptLine();
      promptVisibleRef.current = false;
    }

    chunks.forEach((chunk) => writeLogChunk(chunk));
    previousEntriesRef.current = nextEntries;

    if (canSendCommandsRef.current) writePrompt();
    if (wasAtBottom) terminal.scrollToBottom();
  }

  function writeLogChunk(chunk: string) {
    const terminal = terminalRef.current;
    if (!terminal) return;
    const normalized = minecraftFormattingToAnsi(chunk).replace(/\r?\n/g, "\r\n");
    terminal.write(normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`);
  }

  function writePrompt() {
    if (promptVisibleRef.current || !terminalRef.current) return;
    terminalRef.current.write(`${prompt}${inputRef.current}`);
    terminalRef.current.scrollToBottom();
    promptVisibleRef.current = true;
  }

  function clearPromptLine() {
    terminalRef.current?.write("\r\x1b[2K");
  }

  function renderInputLine() {
    if (!terminalRef.current) return;
    promptVisibleRef.current = true;
    terminalRef.current.write(`\r\x1b[2K${prompt}${inputRef.current}`);
    terminalRef.current.scrollToBottom();
  }

  return (
    <div className={`minecraftTerminalShell ${canSendCommands ? "" : "disabled"}`}>
      <div ref={containerRef} className="minecraftTerminal" aria-label="Minecraft server console" />
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

function diffEntries(previousEntries: string[], nextEntries: string[]) {
  const appendOnly = previousEntries.length <= nextEntries.length
    && previousEntries.every((entry, index) => entry === nextEntries[index]);
  if (appendOnly) return { reset: false, chunks: nextEntries.slice(previousEntries.length) };
  if (!nextEntries.length) return { reset: true, chunks: [] };

  const maxOverlap = Math.min(previousEntries.length, nextEntries.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const previousTail = previousEntries.slice(previousEntries.length - overlap);
    const nextHead = nextEntries.slice(0, overlap);
    if (previousTail.every((entry, index) => entry === nextHead[index])) {
      return { reset: false, chunks: nextEntries.slice(overlap) };
    }
  }

  return { reset: true, chunks: nextEntries };
}
