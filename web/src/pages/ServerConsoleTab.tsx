import { Suspense, useEffect, useRef, useState } from "react";
import { lazyPage } from "../app/lazyPage";
import type { ConsoleFontSize, ConsoleScrollback } from "../features/settings/settingsPreferences";
import type { ConsoleLine } from "../types";
import type { TerminalSelection } from "../components/MinecraftTerminal";
import { ConsolePrompt } from "../components/ConsolePrompt";
import { TerminalLoadingSkeleton } from "../components/LoadingSkeletons";
import { Surface } from "../components/UiPrimitives";
import { copyToClipboard } from "../utils/clipboard";
import { shouldCopyTerminalSelection } from "../utils/minecraftTerminal";

const { Component: MinecraftTerminal, preload: loadMinecraftTerminal } = lazyPage(
  () => import("../components/MinecraftTerminal"),
  (module) => module.MinecraftTerminal
);
export { loadMinecraftTerminal };

/**
 * The console page: an output surface with a command line under it. The terminal stays behind a
 * skeleton until the log snapshot for this server has landed, so switching servers never shows
 * stale output.
 *
 * It stays mounted while the rest of the server workspace is browsed and hides itself when
 * another page is showing, because rebuilding the terminal costs a full re-parse of the
 * scrollback before it can paint anything.
 */
export function ServerConsoleTab({
  active,
  snapshotReady,
  generation,
  entries,
  canSendCommands,
  disabledReason,
  commandHistory,
  fontSize,
  scrollback,
  onCommand
}: {
  active: boolean;
  snapshotReady: boolean;
  generation: number;
  entries: ConsoleLine[];
  canSendCommands: boolean;
  disabledReason: string;
  commandHistory: string[];
  fontSize: ConsoleFontSize;
  scrollback: ConsoleScrollback;
  onCommand: (command: string) => void;
}) {
  const selectionRef = useRef<TerminalSelection | null>(null);
  const [terminalCodeReady, setTerminalCodeReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    const ready = () => { if (!disposed) setTerminalCodeReady(true); };
    // Resolve lazyPage before rendering it to avoid React's Suspense reveal delay. Snapshot
    // delivery proceeds independently. A failed preload falls through to the normal lazy retry.
    void loadMinecraftTerminal().then(ready, ready);
    return () => { disposed = true; };
  }, []);

  /**
   * Answers Ctrl+C for the whole console, in the capture phase so it settles before the command
   * line's own Ctrl+C — which abandons the line — ever sees the keystroke. Handling it here is also
   * what makes the shortcut work while the terminal itself holds focus, where the command line's
   * handler never runs at all.
   */
  function handleCopyShortcut(event: React.KeyboardEvent<HTMLDivElement>) {
    const selection = selectionRef.current;
    const target = event.target as Partial<HTMLInputElement> | null;
    const copyable = shouldCopyTerminalSelection(event, {
      terminal: selection?.text ?? "",
      input: target?.selectionStart != null && target.selectionStart !== target.selectionEnd,
      document: window.getSelection()?.toString() ?? ""
    });
    if (!copyable || !selection) return;

    event.preventDefault();
    event.stopPropagation();
    void copyToClipboard(selection.text).then((copied) => {
      // Letting go of the selection is the only acknowledgement the console can give, and it leaves
      // the next Ctrl+C free to be the shell key again.
      if (copied) selection.clear();
    });
  }

  return (
    <section className="tabPage layoutWide consoleTabPage" hidden={!active}>
      <Surface className="consolePanel" material="solid">
        <div className="terminal">
          <div
            className={`minecraftTerminalShell ${canSendCommands ? "" : "disabled"}`}
            onKeyDownCapture={handleCopyShortcut}
          >
            {terminalCodeReady ? (
              <Suspense fallback={<TerminalLoadingSkeleton />}>
                <MinecraftTerminal
                  snapshotReady={snapshotReady}
                  entries={entries}
                  generation={generation}
                  fontSize={fontSize}
                  scrollback={scrollback}
                  onSelectionChange={(selection) => { selectionRef.current = selection; }}
                />
              </Suspense>
            ) : <TerminalLoadingSkeleton />}
            <ConsolePrompt
              canSendCommands={canSendCommands}
              disabledReason={disabledReason}
              commandHistory={commandHistory}
              fontSize={fontSize}
              onCommand={onCommand}
            />
          </div>
        </div>
      </Surface>
    </section>
  );
}
