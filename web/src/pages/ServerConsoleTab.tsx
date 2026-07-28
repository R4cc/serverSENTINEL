import { lazy, Suspense } from "react";
import type { ConsoleFontSize, ConsoleScrollback } from "../features/settings/settingsPreferences";
import { TerminalLoadingSkeleton } from "../components/LoadingSkeletons";
import { Surface } from "../components/UiPrimitives";

export const loadMinecraftTerminal = () => import("../components/MinecraftTerminal");
const MinecraftTerminal = lazy(() => loadMinecraftTerminal().then((module) => ({ default: module.MinecraftTerminal })));

/**
 * The console page. The terminal stays behind a skeleton until the log snapshot
 * for this server has landed, so switching servers never shows stale output.
 */
export function ServerConsoleTab({
  snapshotReady,
  entries,
  canSendCommands,
  disabledReason,
  commandHistory,
  fontSize,
  scrollback,
  onCommand
}: {
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
    <section className="tabPage layoutWide">
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
