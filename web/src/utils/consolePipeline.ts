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
