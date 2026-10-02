import type { ConsoleLine } from "../types";
import { consoleLineStart } from "./consolePipeline";
import { minecraftLogToTerminalText } from "./minecraftTerminal";

type Output = { write(text: string, complete: () => void): void };

/**
 * Owns parser delivery, independently of React renders. Retain the latest history rather than
 * accumulating another queue, and send only its unwritten suffix. xterm yields between writes,
 * but cannot interrupt parsing one huge string, so keep each write to a small group of whole lines.
 */
export class ConsoleTerminalWriter {
  private entries: readonly ConsoleLine[] = [];
  private generation: number | undefined;
  private sequence = 0;
  private resetPending = false;
  private writing = false;
  private disposed = false;
  private replacing = false;

  constructor(private output: Output, private onIdle: (replaced: boolean, generation: number) => void) {}

  update(entries: readonly ConsoleLine[], generation: number) {
    if (this.disposed) return false;
    this.entries = entries;
    const changed = this.generation !== generation || consoleLineStart(entries, this.sequence) < entries.length;
    if (this.generation !== generation) {
      this.generation = generation;
      this.sequence = 0;
      this.resetPending = true;
      this.replacing = true;
    }
    this.pump();
    return changed;
  }

  dispose() {
    this.disposed = true;
    this.entries = [];
  }

  private pump() {
    if (this.disposed || this.writing) return;
    const start = consoleLineStart(this.entries, this.sequence);
    if (start === this.entries.length && !this.resetPending) return;
    const generation = this.generation;
    if (generation === undefined) return;
    const reset = this.resetPending;
    this.resetPending = false;
    let end = start;
    let length = 0;
    // Prepare a snapshot in larger batches behind its loading state. Once visible, smaller
    // writes prioritize input responsiveness. Using tiny snapshot writes delays the first paint.
    const budget = this.replacing ? 4 * 1024 * 1024 : 256 * 1024;
    while (end < this.entries.length && length < budget) {
      length += this.entries[end++].text.length;
    }
    const texts: string[] = [];
    for (let index = start; index < end; index++) texts.push(this.entries[index].text);
    this.sequence = this.entries[end - 1]?.seq ?? this.sequence;
    this.writing = true;
    // Serialize RIS with pending writes; a synchronous reset can let old output land afterwards.
    // Synchronized output suppresses intermediate paints while a replacement is being parsed.
    // The buffer can yield to input/layout between chunks and still appear in one finished frame.
    const begin = reset ? "\x1bc\x1b[?2026h" : "";
    const endReplacement = this.replacing && end === this.entries.length ? "\x1b[?2026l" : "";
    this.output.write(`${begin}${minecraftLogToTerminalText(texts.join(""))}${endReplacement}`, () => {
      this.writing = false;
      if (this.disposed) return;
      if (this.generation !== generation || consoleLineStart(this.entries, this.sequence) < this.entries.length) {
        this.pump();
        return;
      }
      const replaced = this.replacing;
      this.replacing = false;
      this.onIdle(replaced, generation);
    });
  }
}
