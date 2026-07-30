export type ConsoleConnectionState = "connecting" | "live" | "polling" | "reconnecting" | "offline" | "error";

export type ConsoleUnavailableMessage = {
  message?: string;
  code?: string;
  retryable?: boolean;
};

export function isNodeOfflineConsoleMessage(message: ConsoleUnavailableMessage) {
  return message.code?.toUpperCase() === "NODE_OFFLINE"
    || /node .*offline|node disconnected|disconnected before command/i.test(message.message ?? "");
}

export function consoleUnavailableIsRetryable(message: ConsoleUnavailableMessage) {
  if (typeof message.retryable === "boolean") return message.retryable;
  return isNodeOfflineConsoleMessage(message) || /timed out|temporarily|connection|disconnected/i.test(message.message ?? "");
}

export function consoleReconnectDelay(attempt: number) {
  return Math.min(10_000, 1_000 * (2 ** Math.max(0, attempt)));
}

/**
 * Length of the longest suffix of `left` that is also a prefix of `right`. Console buffers hold
 * thousands of lines and this runs for every batch that arrives, so it compares in place rather
 * than slicing a candidate window per iteration.
 */
function overlapLength(left: string[], right: string[]) {
  const maximum = Math.min(left.length, right.length);
  for (let overlap = maximum; overlap > 0; overlap -= 1) {
    const offset = left.length - overlap;
    let matches = true;
    for (let index = 0; index < overlap; index += 1) {
      if (left[offset + index] !== right[index]) {
        matches = false;
        break;
      }
    }
    if (matches) return overlap;
  }
  return 0;
}

/**
 * A newly opened console websocket replays its existing Docker/file tail before it starts
 * forwarding live output. That replay can be split across several frames, so each early frame
 * may match the middle of the HTTP snapshot rather than its suffix. Track every possible replay
 * position until it catches up instead of appending those historical frames after newer output.
 */
export class ConsoleReplayGuard {
  private cursors: number[] | undefined;
  private replayComplete: boolean;

  constructor(private readonly history: string[]) {
    this.replayComplete = history.length === 0;
  }

  push(incoming: string[]) {
    if (!incoming.length || this.replayComplete) return incoming;

    for (let incomingOffset = 0; incomingOffset < incoming.length; incomingOffset += 1) {
      if (this.cursors === undefined) {
        this.cursors = [];
        for (let historyOffset = 0; historyOffset < this.history.length; historyOffset += 1) {
          if (this.history[historyOffset] === incoming[incomingOffset]) {
            this.cursors.push(historyOffset + 1);
          }
        }
      } else {
        this.cursors = this.cursors
          .filter((cursor) => cursor < this.history.length && this.history[cursor] === incoming[incomingOffset])
          .map((cursor) => cursor + 1);
      }
      if (!this.cursors.length) {
        this.replayComplete = true;
        return incoming.slice(incomingOffset);
      }
    }
    return [];
  }
}

export function consoleSnapshotLines(text: string, limit = 5_000) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-limit);
}

/**
 * The console websocket carries raw stream chunks — one frame can hold several lines or stop
 * mid-line — while snapshot fetches produce one entry per line. Splitting the stream into the
 * same units the snapshot uses is what lets the two sources overlap and reconcile; mixing chunk
 * entries with line entries left them with nothing in common, so every refresh replaced the
 * whole buffer and made the terminal clear and redraw itself.
 */
export class ConsoleLineAssembler {
  private pending = "";

  push(chunk: string) {
    const text = this.pending + chunk;
    const lastLineFeed = text.lastIndexOf("\n");
    if (lastLineFeed === -1) {
      this.pending = text;
      return [];
    }
    this.pending = text.slice(lastLineFeed + 1);
    return text.slice(0, lastLineFeed + 1).split(/\r?\n/).slice(0, -1).map((line) => `${line}\n`);
  }

  reset() {
    this.pending = "";
  }
}

export function appendConsoleEntries(current: string[], incoming: string[], limit = 5_000) {
  if (!incoming.length) return current.slice(-limit);
  const overlap = overlapLength(current, incoming);
  return [...current, ...incoming.slice(overlap)].slice(-limit);
}

export function reconcileConsoleSnapshot(start: string[], snapshot: string[], current: string[], limit = 5_000) {
  // `current` is `start` plus whatever the live stream appended while the snapshot request was
  // in flight, with the head trimmed once the buffer hits the scrollback limit. Locating the
  // carried-over portion recovers the live tail even after trimming; requiring `start` to still
  // be a leading prefix dropped those lines on any busy console, which then forced the terminal
  // to clear and redraw the whole buffer.
  const carried = overlapLength(start, current);
  const liveTail = current.slice(carried);
  if (!snapshot.length) return liveTail.length ? appendConsoleEntries([], liveTail, limit) : [];

  const base = snapshotBase(start, snapshot);
  return appendConsoleEntries(base, liveTail, limit);
}

/**
 * Places the snapshot relative to the buffer the console started from. The snapshot usually
 * continues where that buffer ends, but a chatty server keeps the websocket ahead of the file the
 * snapshot reads, so it can also stop short of lines the console already shows. Taking the
 * snapshot as-is there rewinds the buffer, and a buffer that loses its tail leaves the terminal
 * nothing to append to — it clears and redraws every row, which is the flash this avoids.
 */
function snapshotBase(start: string[], snapshot: string[]) {
  const continues = overlapLength(start, snapshot);
  if (continues > 0) return [...start, ...snapshot.slice(continues)];

  const precedes = overlapLength(snapshot, start);
  if (precedes > 0) return [...snapshot.slice(0, snapshot.length - precedes), ...start];

  return snapshot;
}
