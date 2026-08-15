export type ConsoleConnectionState = "connecting" | "live" | "polling" | "reconnecting" | "offline" | "error";

type ConsoleUnavailableMessage = {
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

/**
 * Whether a console that reports the node offline is contradicted by the node record itself.
 *
 * A console stream can end while the node stays reachable, and the browser has no other reason to
 * revisit that verdict: the offline state it holds is what every page reads to decide the node is
 * down, so it outlives the failure and only a reload clears it. The contradiction is worth exactly
 * one reconnect — `alreadyRechecked` is what keeps a console that genuinely cannot attach from
 * being retried on every connectivity poll.
 */
export function consoleOfflineContradictsNode(input: {
  consoleConnectionState: ConsoleConnectionState;
  nodeRuntimeUsable: boolean;
  alreadyRechecked: boolean;
}) {
  return input.consoleConnectionState === "offline" && input.nodeRuntimeUsable && !input.alreadyRechecked;
}

export function consoleReconnectDelay(attempt: number) {
  return Math.min(10_000, 1_000 * (2 ** Math.max(0, attempt)));
}
