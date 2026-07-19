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

function eventKey(event: ServerEvent) {
  return createHash("sha1")
    .update([event.source, event.timestamp, event.signature, event.message, event.details ?? ""].join("\u0000"))
    .digest("hex");
}

export class TimelineEventCollector {
  private readonly inFlight = new Map<string, Promise<void>>();
  private interval: NodeJS.Timeout | undefined;

  constructor(private readonly options: TimelineEventCollectorOptions) {}

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
      const referenceTime = referenceDate.getTime();
      const cutoff = referenceTime - this.options.retentionMs;
      text.split(/\r?\n/).forEach((line, index) => {
        const event = this.options.parseLine(line, source, index, referenceDate);
        if (!event?.timestamp) return;
        const occurredAt = new Date(event.timestamp).getTime();
        if (!Number.isFinite(occurredAt) || occurredAt < cutoff || occurredAt > referenceTime + futureEventToleranceMs) return;
        this.options.repository.append(server.id, eventKey(event), { ...event, occurredAt });
      });
    } catch (error) {
      this.options.onError?.(error, server);
    }
  }
}
