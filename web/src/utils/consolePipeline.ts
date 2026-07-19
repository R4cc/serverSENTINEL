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

function overlapLength(left: string[], right: string[]) {
  const maximum = Math.min(left.length, right.length);
  for (let overlap = maximum; overlap > 0; overlap -= 1) {
    if (left.slice(-overlap).every((line, index) => line === right[index])) return overlap;
  }
  return 0;
}

export function consoleSnapshotLines(text: string, limit = 5_000) {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines.slice(-limit);
}

export function appendConsoleEntries(current: string[], incoming: string[], limit = 5_000) {
  if (!incoming.length) return current.slice(-limit);
  const overlap = overlapLength(current, incoming);
  return [...current, ...incoming.slice(overlap)].slice(-limit);
}

export function reconcileConsoleSnapshot(start: string[], snapshot: string[], current: string[], limit = 5_000) {
  const startStillPresent = start.length <= current.length && start.every((line, index) => current[index] === line);
  const liveTail = startStillPresent ? current.slice(start.length) : [];
  if (!snapshot.length) return liveTail.length ? appendConsoleEntries([], liveTail, limit) : [];

  const overlap = overlapLength(start, snapshot);
  const base = overlap > 0 ? [...start, ...snapshot.slice(overlap)] : snapshot;
  return appendConsoleEntries(base, liveTail, limit);
}
