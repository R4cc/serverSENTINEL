import type { ActivePage } from "../types";

/**
 * Every page behind a lazy chunk pays a full round trip on its first visit before it can render
 * anything, which is where the wait comes from: a repeat visit settles in well under a tenth of
 * the time. Pulling those chunks in while the browser is idle makes the first visit cost the same
 * as the second.
 *
 * Console goes first because its one-time module evaluation and xterm setup dominate the first
 * page switch; starting them in the first idle slot keeps that work out of the interaction. The
 * remaining, smaller chunks follow cheapest-first.
 */
export const pagePrefetchOrder: ActivePage[] = [
  "console",
  "files",
  "nodes",
  "mods",
  "schedule",
  "players",
  "properties",
  "settings"
];

type NetworkInformation = {
  saveData?: boolean;
  effectiveType?: string;
};

/**
 * Speculative downloads are only ever a trade: bytes now against a wait later. On a metered or
 * slow connection that trade stops paying, so the queue is skipped entirely rather than competing
 * with the page the visitor actually asked for.
 */
export function pagePrefetchAllowed(connection: NetworkInformation | undefined) {
  if (!connection) return true;
  if (connection.saveData) return false;
  return connection.effectiveType !== "slow-2g" && connection.effectiveType !== "2g";
}

/** Only Chromium exposes the Network Information API; elsewhere this is simply unknown. */
export function networkInformation(): NetworkInformation | undefined {
  return (navigator as Navigator & { connection?: NetworkInformation }).connection;
}

/**
 * Runs `task` when the browser next goes idle. Falls back to a timeout where
 * `requestIdleCallback` is missing, and returns a canceller either way.
 */
export function whenIdle(task: () => void, timeoutMs = 2_000) {
  if (typeof window.requestIdleCallback === "function") {
    const handle = window.requestIdleCallback(task, { timeout: timeoutMs });
    return () => window.cancelIdleCallback(handle);
  }
  const handle = window.setTimeout(task, 200);
  return () => window.clearTimeout(handle);
}
