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

  const overlap = overlapLength(start, snapshot);
  const base = overlap > 0 ? [...start, ...snapshot.slice(overlap)] : snapshot;
  return appendConsoleEntries(base, liveTail, limit);
}
