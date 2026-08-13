import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "lucide-react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { terminalPreferenceOptions, type ConsoleFontSize, type ConsoleScrollback } from "../features/settings/settingsPreferences";
import type { ConsoleLine } from "../types";
import { consumeTerminalTouchScroll, minecraftLogToTerminalText, terminalViewportAtBottom } from "../utils/minecraftTerminal";

/** What the console page needs of a terminal selection to copy it and to let go of it afterwards. */
export type TerminalSelection = {
  text: string;
  clear(): void;
};

type MinecraftTerminalProps = {
  entries: ConsoleLine[];
  /** Changes when the console was replaced rather than extended, which is the cue to clear. */
  generation: number;
  fontSize: ConsoleFontSize;
  scrollback: ConsoleScrollback;
  /**
   * Reports what is selected as it changes. The selection is drawn by xterm rather than held by the
   * document, so it is invisible to `window.getSelection()` and nothing outside this component can
   * see it — including the Ctrl+C the page has to answer.
   */
  onSelectionChange?: (selection: TerminalSelection) => void;
};

type TerminalTheme = ReturnType<typeof terminalTheme>;

/**
 * The console's output surface, and only that. Command entry is a real input next to it — see
 * {@link ../components/ConsolePrompt} — which leaves this with nothing to draw but the workload's
 * output, and nothing to redraw at all.
 */
export function MinecraftTerminal({ entries, generation, fontSize, scrollback, onSelectionChange }: MinecraftTerminalProps) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const selectionListenerRef = useRef(onSelectionChange);
  const fitRef = useRef<() => void>(() => {});
  const initialRenderCompleteRef = useRef(false);
  const lastWrittenSeqRef = useRef(0);
  const writtenGenerationRef = useRef(generation);
  const entriesRef = useRef(entries);
  const appliedThemeRef = useRef<TerminalTheme | null>(null);
  const [newOutputAvailable, setNewOutputAvailable] = useState(false);

  entriesRef.current = entries;
  selectionListenerRef.current = onSelectionChange;

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
    // xterm creates a focusable input surface even when stdin is disabled. This terminal is output
    // only, so leave the helper available for xterm's mouse-driven selection internals without
    // exposing an invisible, non-functional "Terminal input" control in the keyboard or a11y flow.
    if (terminal.textarea) {
      terminal.textarea.tabIndex = -1;
      terminal.textarea.setAttribute("aria-hidden", "true");
    }
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
    let contextLoss: { dispose(): void } | undefined;
    let terminalDisposed = false;
    const activateWebgl = async () => {
      try {
        // The addon is a quarter of the console chunk and is useless on every device that cannot
        // run it, so it is fetched here rather than imported at module scope. By this point the
        // terminal has already painted, so the download is off the interaction path entirely.
        const { WebglAddon } = await import("@xterm/addon-webgl");
        // The import can settle after a fast navigation away; loading an addon into a disposed
        // terminal throws, and constructing one would take a GPU context nothing would release.
        if (terminalDisposed) return;
        webglAddon = new WebglAddon();
        contextLoss = webglAddon.onContextLoss(disposeWebgl);
        terminal.loadAddon(webglAddon);
      } catch {
        disposeWebgl();
      }
    };
    // Opening, fitting and painting xterm already costs the first console frame. Let the DOM
    // renderer produce that frame, then upgrade to WebGL after the interaction has settled so GPU
    // setup and shader compilation cannot turn the page switch into one long blocking task.
    const webglStartTimer = window.setTimeout(() => void activateWebgl(), 1_000);

    const selectionChange = terminal.onSelectionChange(() => {
      selectionListenerRef.current?.({
        text: terminal.getSelection(),
        clear: () => terminal.clearSelection()
      });
    });
    const scrollChange = terminal.onScroll((viewportY) => {
      if (terminalViewportAtBottom(viewportY, terminal.buffer.active.baseY)) {
        setNewOutputAvailable(false);
      }
    });

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
    //
    // A console with no box yet is the case to refuse rather than to attempt. Asked to fit into
    // nothing, xterm does not decline — it proposes its minimum geometry and takes it, which is how
    // a terminal that mounts behind `hidden`, or one frame ahead of its own layout, ends up a
    // handful of columns wide with every line of output wrapped to match. Reporting whether a fit
    // happened lets the first write wait for a real one instead of drawing into that.
    const fit = () => {
      if (!container.clientWidth || !container.clientHeight) return false;
      try {
        fitAddon.fit();
        return true;
      } catch {
        return false;
      }
    };
    fitRef.current = fit;

    // The buffer is written once the terminal has a width to wrap it against. Until then the
    // console stays behind its skeleton: there is no width at which the output would be right, and
    // rewrapping it afterwards is the reflow this is here to avoid.
    let initialized = false;
    const initialize = () => {
      if (!fit()) return;
      initialized = true;
      initialRenderCompleteRef.current = true;
      writeEntries(entriesRef.current, true);
      terminal.write("", () => {
        if (terminalRef.current !== terminal) return;
        terminal.scrollToBottom();
        shellRef.current?.classList.remove("initializing");
      });
    };

    let fitFrame: number | null = null;
    const scheduleFit = () => {
      if (fitFrame !== null) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = null;
        if (initialized) fit();
        else initialize();
      });
    };

    const visualViewport = window.visualViewport;
    visualViewport?.addEventListener("resize", scheduleFit);
    window.addEventListener("resize", scheduleFit);

    scheduleFit();

    // Observing also delivers the container's current size, so a console that is already laid out
    // initializes from here and one that is not initializes on the frame it gains a box.
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
      window.clearTimeout(webglStartTimer);
      contextLoss?.dispose();
      selectionChange.dispose();
      scrollChange.dispose();
      // Nothing is selected in a terminal that no longer exists, and the page must not be left
      // holding a selection whose clear() would reach into a disposed terminal.
      selectionListenerRef.current?.({ text: "", clear: () => {} });
      fitRef.current = () => {};
      terminalRef.current = null;
      appliedThemeRef.current = null;
      initialRenderCompleteRef.current = false;
      // Release the GPU context before the terminal goes away; navigating between servers
      // remounts this component and browsers cap how many live WebGL contexts a page may hold.
      terminalDisposed = true;
      disposeWebgl();
      terminal.dispose();
    };
  }, []);

  // The palette lives in CSS variables, so there is no prop to depend on. Reading it means
  // `getComputedStyle` plus four `getPropertyValue` calls, which force the browser to flush
  // pending style recalculation — so this must not run per render. Every log flush is a render,
  // and at streaming rates that is up to sixty forced recalcs a second.
  //
  // The trigger is enumerable instead: the palette only moves when the theme class changes, and
  // App writes that class onto both the document element and the app shell (including when the
  // system scheme flips, which it folds into the same class). Watch those and read on demand.
  //
  // Assigning `options.theme` is compared by reference inside xterm, so handing it a fresh object
  // rebuilds the colour set and forces a full repaint of every row — at streaming log rates that
  // reads as flicker. Only assign when the resolved colours actually changed.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const applyTheme = () => {
      const terminal = terminalRef.current;
      if (!terminal) return;
      const nextTheme = terminalTheme(window.getComputedStyle(container));
      if (appliedThemeRef.current && sameTerminalTheme(appliedThemeRef.current, nextTheme)) return;
      appliedThemeRef.current = nextTheme;
      terminal.options.theme = nextTheme;
    };

    const observer = new MutationObserver(applyTheme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const shell = container.closest(".appShell");
    if (shell) observer.observe(shell, { attributes: true, attributeFilter: ["class"] });
    applyTheme();
    return () => observer.disconnect();
  }, []);

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

    const wasAtBottom = terminalViewportAtBottom(terminal.buffer.active.viewportY, terminal.buffer.active.baseY);
    if (reset) {
      setNewOutputAvailable(false);
      terminal.reset();
    }

    // One write for the whole batch: thousands of lines cost a single parser pass rather than one
    // queued write each.
    terminal.write(minecraftLogToTerminalText(fresh.map((line) => line.text).join("")));
    lastWrittenSeqRef.current = fresh[fresh.length - 1]?.seq ?? lastWrittenSeqRef.current;

    // Reading a log line is not a reason to yank someone who scrolled up back to the newest
    // output; only follow the tail when they were already pinned to it.
    if (wasAtBottom) terminal.scrollToBottom();
    else if (!reset && fresh.length) setNewOutputAvailable(true);
  }

  function jumpToBottom() {
    terminalRef.current?.scrollToBottom();
    setNewOutputAvailable(false);
  }

  return (
    <div ref={shellRef} className="minecraftTerminal initializing" role="region" aria-label="Minecraft server console">
      <div ref={containerRef} className="minecraftTerminalViewport" />
      {newOutputAvailable && (
        <button
          type="button"
          className="consoleJumpToBottom"
          aria-label="Jump to bottom of console"
          title="Jump to bottom"
          onClick={jumpToBottom}
        >
          <ArrowDown aria-hidden="true" />
          <span>New output</span>
        </button>
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
