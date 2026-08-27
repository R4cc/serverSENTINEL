import { createHash } from "node:crypto";
import type { ManagedServer, ServerEvent } from "./types.js";
import type { TimelineEventsRepository } from "./storage/timelineEventsRepository.js";

type RecentLogs = { text?: string; source?: ServerEvent["source"] };

type TimelineEventCollectorOptions = {
  intervalMs: number;
  retentionMs: number;
  readServers: () => Promise<ManagedServer[]>;
  readLogs: (server: ManagedServer) => Promise<unknown>;
  parseLine: (line: string, source: ServerEvent["source"], index: number, referenceDate: Date) => ServerEvent | null;
  repository: TimelineEventsRepository;
  onError?: (error: unknown, server?: ManagedServer) => void;
};

const futureEventToleranceMs = 5 * 60 * 1000;

/**
 * A reader of the console output this collector has already fetched.
 *
 * The panel polls each server's recent log once, for the timeline. Anything else that needs the
 * same text — Player Insights reads the login lines out of it — subscribes here rather than
 * fetching it again, which is the difference between one node request per server and two.
 *
 * Observers are given what was read and nothing else: no control over the poll, no say in what is
 * parsed. Whatever they do with it is their business, including doing nothing at all while their
 * module is switched off, which is why unsubscribing is the whole of that gate.
 */
export type ServerLogObserver = (input: {
  server: ManagedServer;
  text: string;
  source: ServerEvent["source"];
  referenceDate: Date;
}) => void | Promise<void>;

function eventIdentity(event: ServerEvent) {
  return createHash("sha1")
    .update([event.source, event.timestamp, event.signature, event.message, event.details ?? ""].join("\u0000"))
    .digest("hex");
}

function eventKey(identity: string, occurrence: number) {
  // Preserve the historic key for the common first occurrence so deploying this fix does not
  // duplicate every retained event. Only genuinely repeated lines at the same instant gain a
  // suffix, allowing join/leave/join sequences to survive as three distinct state changes.
  if (occurrence === 0) return identity;
  return `${identity}:${occurrence}`;
}

export class TimelineEventCollector {
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly logObservers = new Set<ServerLogObserver>();
  private interval: NodeJS.Timeout | undefined;

  constructor(private readonly options: TimelineEventCollectorOptions) {}

  /** Subscribes to the console output this collector reads. Returns the unsubscribe. */
  observeLogs(observer: ServerLogObserver) {
    this.logObservers.add(observer);
    return () => {
      this.logObservers.delete(observer);
    };
  }

  start() {
    if (this.interval) return;
    this.options.repository.prune(Date.now() - this.options.retentionMs);
    void this.collectAll();
    this.interval = setInterval(() => void this.collectAll(), this.options.intervalMs);
    this.interval.unref?.();
  }

  stop() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = undefined;
  }

  async collectAll() {
    try {
      const servers = await this.options.readServers();
      await Promise.allSettled(servers.map((server) => this.collectServer(server)));
      this.options.repository.prune(Date.now() - this.options.retentionMs);
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  async collectServer(server: ManagedServer) {
    const existing = this.inFlight.get(server.id);
    if (existing) return existing;
    const request = this.collectServerOnce(server).finally(() => this.inFlight.delete(server.id));
    this.inFlight.set(server.id, request);
    return request;
  }

  private async collectServerOnce(server: ManagedServer) {
    try {
      const result = await this.options.readLogs(server) as RecentLogs;
      const text = typeof result?.text === "string" ? result.text : "";
      const source = result?.source === "logs/latest.log" ? "logs/latest.log" : "docker";
      const referenceDate = new Date();
      // Before parsing, and never allowed to interfere with it: an observer that throws is its own
      // problem, and must not cost this server its timeline events for the pass.
      for (const observer of this.logObservers) {
        try {
          await observer({ server, text, source, referenceDate });
        } catch (error) {
          this.options.onError?.(error, server);
        }
      }
      const referenceTime = referenceDate.getTime();
      const cutoff = referenceTime - this.options.retentionMs;
      const events: Array<{ eventKey: string; event: ServerEvent & { occurredAt: number } }> = [];
      const occurrences = new Map<string, number>();
      text.split(/\r?\n/).forEach((line, index) => {
        const event = this.options.parseLine(line, source, index, referenceDate);
        if (!event?.timestamp) return;
        const occurredAt = new Date(event.timestamp).getTime();
        if (!Number.isFinite(occurredAt) || occurredAt < cutoff || occurredAt > referenceTime + futureEventToleranceMs) return;
        const baseKey = eventIdentity(event);
        const occurrence = occurrences.get(baseKey) ?? 0;
        occurrences.set(baseKey, occurrence + 1);
        events.push({ eventKey: eventKey(baseKey, occurrence), event: { ...event, occurredAt } });
      });
      if (events.length > 0) this.options.repository.appendMany(server.id, events);
    } catch (error) {
      this.options.onError?.(error, server);
    }
  }
}
