import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { terminalPreferenceOptions, type ConsoleFontSize, type ConsoleScrollback } from "../features/settings/settingsPreferences";
import type { ConsoleLine } from "../types";
import { consumeTerminalTouchScroll, minecraftLogToTerminalText } from "../utils/minecraftTerminal";

type MinecraftTerminalProps = {
  entries: ConsoleLine[];
  /** Changes when the console was replaced rather than extended, which is the cue to clear. */
  generation: number;
  fontSize: ConsoleFontSize;
  scrollback: ConsoleScrollback;
};

type TerminalTheme = ReturnType<typeof terminalTheme>;

/**
 * The console's output surface, and only that. Command entry is a real input next to it — see
 * {@link ../components/ConsolePrompt} — which leaves this with nothing to draw but the workload's
 * output, and nothing to redraw at all.
 */
export function MinecraftTerminal({ entries, generation, fontSize, scrollback }: MinecraftTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const initialRenderCompleteRef = useRef(false);
  const lastWrittenSeqRef = useRef(0);
  const writtenGenerationRef = useRef(generation);
  const entriesRef = useRef(entries);
  const appliedThemeRef = useRef<TerminalTheme | null>(null);

  entriesRef.current = entries;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const styles = window.getComputedStyle(container);
    const initialTheme = terminalTheme(styles);
    appliedThemeRef.current = initialTheme;
    const terminal = new Terminal({
      allowTransparency: true,
      convertEol: false,
      // Nothing is typed here, so there is no caret to show and no keyboard to accept.
      cursorInactiveStyle: "none",
      disableStdin: true,
      fontFamily: styles.getPropertyValue("--font-mono") || "ui-monospace, SFMono-Regular, Consolas, monospace",
      tabStopWidth: 2,
      theme: initialTheme,
      ...terminalPreferenceOptions(fontSize, scrollback)
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    terminal.open(container);
    terminalRef.current = terminal;

    // The fallback DOM renderer rewrites a row's markup for every cell change, so a scrolling
    // console repaints the whole viewport line by line. The GPU renderer draws it as one frame.
    // It has to be loaded after open(), and it is unavailable often enough — no WebGL2, a
    // blocklisted driver, a lost context after the GPU resets — that both paths have to work.
    let webglAddon: WebglAddon | null = null;
    const disposeWebgl = () => {
      webglAddon?.dispose();
      webglAddon = null;
    };
    const contextLoss: { dispose(): void } | undefined = (() => {
      try {
        webglAddon = new WebglAddon();
        const listener = webglAddon.onContextLoss(disposeWebgl);
        terminal.loadAddon(webglAddon);
        return listener;
      } catch {
        disposeWebgl();
        return undefined;
      }
    })();

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

    // Reflow is now just reflow: there is no drawn input line for a resize to strand, which is
    // what the phone keyboard opening and closing used to disturb.
    const fit = () => {
      try {
        fitAddon.fit();
      } catch {
        // xterm cannot fit while hidden or zero-sized; the next resize will retry.
      }
    };
    fitRef.current = fit;

    let fitFrame: number | null = null;
    const scheduleFit = () => {
      if (fitFrame !== null) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        fit();
      });
    };

    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", scheduleFit);
    window.addEventListener("resize", scheduleFit);

    fitFrame = window.requestAnimationFrame(() => {
      fitFrame = null;
      fit();
      initialRenderCompleteRef.current = true;
      writeEntries(entriesRef.current, true);
      terminal.write("", () => {
        if (terminalRef.current !== terminal) return;
        terminal.scrollToBottom();
        container.classList.remove("initializing");
      });
    });

    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(container);

    return () => {
      if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
      resizeObserver.disconnect();
      container.removeEventListener("touchstart", handleTouchStart);
      container.removeEventListener("touchmove", handleTouchMove);
      container.removeEventListener("touchend", handleTouchEnd);
      container.removeEventListener("touchcancel", handleTouchEnd);
      visualViewport?.removeEventListener("resize", scheduleFit);
      window.removeEventListener("resize", scheduleFit);
      contextLoss?.dispose();
      fitRef.current = () => {};
      terminalRef.current = null;
      appliedThemeRef.current = null;
      initialRenderCompleteRef.current = false;
      // Release the GPU context before the terminal goes away; navigating between servers
      // remounts this component and browsers cap how many live WebGL contexts a page may hold.
      disposeWebgl();
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
    window.requestAnimationFrame(() => fitRef.current());
  }, [fontSize]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !initialRenderCompleteRef.current) return;
    terminal.options.scrollback = scrollback;
  }, [scrollback]);

  useEffect(() => {
    const terminal = terminalRef.current;
    if (!terminal || !initialRenderCompleteRef.current) return;
    const replaced = writtenGenerationRef.current !== generation;
    writtenGenerationRef.current = generation;
    if (replaced) lastWrittenSeqRef.current = 0;
    writeEntries(entries, replaced);
  }, [entries, generation]);

  /**
   * Writes whatever is new. Lines carry a sequence, so "new" is everything past the last one drawn
   * — no comparing this render's array against the previous one, and no case where the comparison
   * fails and the whole console has to be redrawn. Clearing happens only when the caller says the
   * console was replaced rather than extended, by way of a new generation.
   */
  function writeEntries(nextEntries: ConsoleLine[], reset: boolean) {
    const terminal = terminalRef.current;
    if (!terminal) return;

    const fresh = reset ? nextEntries : nextEntries.filter((line) => line.seq > lastWrittenSeqRef.current);
    if (!fresh.length && !reset) return;

    const wasAtBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
    if (reset) terminal.reset();

    // One write for the whole batch: thousands of lines cost a single parser pass rather than one
    // queued write each.
    terminal.write(minecraftLogToTerminalText(fresh.map((line) => line.text).join("")));
    lastWrittenSeqRef.current = fresh[fresh.length - 1]?.seq ?? lastWrittenSeqRef.current;

    // Reading a log line is not a reason to yank someone who scrolled up back to the newest
    // output; only follow the tail when they were already pinned to it.
    if (wasAtBottom) terminal.scrollToBottom();
  }

  return <div ref={containerRef} className="minecraftTerminal initializing" aria-label="Minecraft server console" />;
}

function cssVar(styles: CSSStyleDeclaration, name: string, fallback: string) {
  return styles.getPropertyValue(name).trim() || fallback;
}

function terminalTheme(styles: CSSStyleDeclaration) {
  return {
    background: cssVar(styles, "--terminal-bg", "#17191e"),
    foreground: cssVar(styles, "--terminal-text", "#dfe3eb"),
    // Nothing is typed into this terminal, so it has no cursor to show. `cursorInactiveStyle`
    // covers it while unfocused, but clicking to select text focuses xterm's hidden textarea and
    // brings the focused cursor back — a block sitting under the last line of output, right above
    // the command line. Focus has to stay available for copying, so the cursor is drawn in nothing.
    cursor: "rgba(0, 0, 0, 0)",
    selectionBackground: "rgba(112, 208, 255, 0.28)"
  };
}

function sameTerminalTheme(left: TerminalTheme, right: TerminalTheme) {
  return left.background === right.background
    && left.foreground === right.foreground
    && left.cursor === right.cursor
    && left.selectionBackground === right.selectionBackground;
}
