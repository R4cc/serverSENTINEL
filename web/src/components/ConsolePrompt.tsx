import { useEffect, useRef, useState } from "react";
import type { ConsoleFontSize } from "../features/settings/settingsPreferences";
import { recallNextCommand, recallPreviousCommand, type TerminalHistoryState } from "../utils/minecraftTerminal";

type ConsolePromptProps = {
  canSendCommands: boolean;
  disabledReason: string;
  commandHistory: string[];
  /** The console's own type size, so the command line is set like the output above it. */
  fontSize: ConsoleFontSize;
  onCommand(command: string): void;
};

/**
 * The console's command line.
 *
 * This is a real text input rather than characters echoed into the terminal. Nothing is gained by
 * echoing: there is no pseudo-terminal behind this console — output is log text and commands go out
 * over HTTP — so the terminal was only ever redrawing a line it had drawn itself. Doing that meant
 * hand-writing a caret, selection, undo, word deletion, wrapping and IME composition, and repainting
 * the line on every keystroke and every batch of arriving output. The browser does all of it, and a
 * caret it owns cannot be caught mid-redraw by a frame that lands at the wrong moment.
 */
export function ConsolePrompt({ canSendCommands, disabledReason, commandHistory, fontSize, onCommand }: ConsolePromptProps) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState("");
  // Where arrow-key recall currently sits, and what was typed before it started.
  const [history, setHistory] = useState<{ index: number | null; draft: string }>({ index: null, draft: "" });

  useEffect(() => {
    if (!canSendCommands) {
      setValue("");
      setHistory({ index: null, draft: "" });
    }
  }, [canSendCommands]);

  function applyRecall(next: TerminalHistoryState) {
    setValue(next.value);
    setHistory({ index: next.historyIndex, draft: next.draft });
    // The caret belongs after a recalled command, the way a shell leaves it.
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (input) input.setSelectionRange(input.value.length, input.value.length);
    });
  }

  function recallState(): TerminalHistoryState {
    return { value, historyIndex: history.index, draft: history.draft };
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowUp") {
      event.preventDefault();
      applyRecall(recallPreviousCommand(commandHistory, recallState()));
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      applyRecall(recallNextCommand(commandHistory, recallState()));
      return;
    }
    // Ctrl+C abandons the line, as it would in a shell — but only when it would not be a copy.
    // Text selected inside an input is not exposed through window.getSelection().
    const inputSelection = event.currentTarget.selectionStart !== event.currentTarget.selectionEnd;
    if (event.ctrlKey && event.key.toLowerCase() === "c" && !inputSelection && !window.getSelection()?.toString()) {
      event.preventDefault();
      setValue("");
      setHistory({ index: null, draft: "" });
    }
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = value.trim();
    setValue("");
    setHistory({ index: null, draft: "" });
    if (command) onCommand(command);
  }

  if (!canSendCommands) {
    return (
      <div className="consolePromptStatus">
        {disabledReason || "Console command input is unavailable."}
      </div>
    );
  }

  return (
    <form
      className="consolePrompt"
      // The terminal's type size is a preference, not a token, so the row reads it from here.
      style={{ "--console-prompt-font-size": `${fontSize}px` } as React.CSSProperties}
      onSubmit={handleSubmit}
    >
      <span className="consolePromptMarker" aria-hidden="true">&gt;</span>
      <input
        ref={inputRef}
        className="consolePromptInput"
        type="text"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          if (history.index !== null) setHistory({ index: null, draft: "" });
        }}
        onKeyDown={handleKeyDown}
        aria-label="Console command"
        placeholder="Type a command"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        enterKeyHint="send"
      />
    </form>
  );
}
