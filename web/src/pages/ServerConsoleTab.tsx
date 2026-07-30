import { Suspense } from "react";
import { lazyPage } from "../app/lazyPage";
import type { ConsoleFontSize, ConsoleScrollback } from "../features/settings/settingsPreferences";
import { TerminalLoadingSkeleton } from "../components/LoadingSkeletons";
import { Surface } from "../components/UiPrimitives";

const { Component: MinecraftTerminal, preload: loadMinecraftTerminal } = lazyPage(
  () => import("../components/MinecraftTerminal"),
  (module) => module.MinecraftTerminal
);
export { loadMinecraftTerminal };

/**
 * The console page. The terminal stays behind a skeleton until the log snapshot
 * for this server has landed, so switching servers never shows stale output.
 *
 * It stays mounted while the rest of the server workspace is browsed and hides itself when
 * another page is showing, because rebuilding the terminal costs a full re-parse of the
 * scrollback before it can paint anything.
 */
export function ServerConsoleTab({
  active,
  snapshotReady,
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
  entries: string[];
  canSendCommands: boolean;
  disabledReason: string;
  commandHistory: string[];
  fontSize: ConsoleFontSize;
  scrollback: ConsoleScrollback;
  onCommand: (command: string) => void;
}) {
  return (
    <section className="tabPage layoutWide consoleTabPage" hidden={!active}>
      <Surface className="consolePanel">
        <div className="terminal">
          {!snapshotReady ? (
            <TerminalLoadingSkeleton />
          ) : (
            <Suspense fallback={<TerminalLoadingSkeleton />}>
              <MinecraftTerminal
                entries={entries}
                canSendCommands={canSendCommands}
                disabledReason={disabledReason}
                commandHistory={commandHistory}
                fontSize={fontSize}
                scrollback={scrollback}
                onCommand={onCommand}
              />
            </Suspense>
          )}
        </div>
      </Surface>
    </section>
  );
}
