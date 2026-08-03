/**
 * One console buffer per managed server, shared by every viewer of that server.
 *
 * Console output used to reach the browser through two independent paths — an HTTP tail and a
 * websocket follow — that shared no line identity, so the browser had to guess how they overlapped
 * by comparing text. Every failure of that guess redrew the whole console. This owns the workload's
 * output instead: raw chunks are framed into lines once, on the way in, and numbered. A viewer then
 * resumes with "everything after 4210", which cannot be ambiguous and cannot fail into a redraw.
 *
 * Sequence numbers are only meaningful inside an `epoch`. A channel that is evicted and rebuilt gets
 * a new epoch, which is how a viewer learns its numbers no longer refer to anything.
 */

import { randomUUID } from "node:crypto";
import type { ConsoleBacklog, ConsoleEpoch, ConsoleLine } from "@serversentinel/contracts";

/** Held per server, so this bounds panel memory across every console anyone has opened. */
export const consoleChannelMaxLines = 25_000;
export const consoleChannelMaxBytes = 8 * 1024 * 1024;
/**
 * How long a channel outlives its last viewer. Browsing away from the console and back is the
 * common case, and keeping the upstream attached over that gap is what makes the return free
 * rather than a rebuild the viewer sees as a full redraw.
 */
export const consoleChannelIdleGraceMs = 5 * 60 * 1000;

export type ConsoleUpstream = {
  /** Raw workload output. Partial lines are expected and are held until they complete. */
  write(chunk: string): void;
  /** A panel-authored line, already complete, for things the viewer would otherwise see as a silent gap. */
  notice(message: string): void;
  unavailable(message: string, options?: { code?: string; retryable?: boolean }): void;
  empty(message?: string): void;
  /**
   * This producer has stopped feeding the channel and will send nothing more. Producers that
   * recover on their own — a docker follow that reattaches, a file tail that keeps polling — must
   * not call it; it is for a producer that is genuinely finished, so the hub knows to start a new
   * one for the next viewer instead of holding a dead one as live.
   */
  ended?(): void;
};

export type ConsoleSubscriber = {
  lines(lines: ConsoleLine[], epoch: ConsoleEpoch): void;
  unavailable(message: string, options?: { code?: string; retryable?: boolean }): void;
  empty(message?: string): void;
};

type ConsoleChannelOptions = {
  maxLines?: number;
  maxBytes?: number;
};

export class ConsoleChannel {
  readonly epoch: ConsoleEpoch = randomUUID();

  private readonly maxLines: number;
  private readonly maxBytes: number;
  private lines: ConsoleLine[] = [];
  private bufferedBytes = 0;
  private nextSeq = 1;
  /** Lowest sequence still retained. A viewer asking for anything older gets told it was truncated. */
  private oldestSeq = 1;
  private pending = "";
  private subscribers = new Set<ConsoleSubscriber>();
  private lastUnavailable: { message: string; code?: string; retryable?: boolean } | undefined;

  constructor(options: ConsoleChannelOptions = {}) {
    this.maxLines = options.maxLines ?? consoleChannelMaxLines;
    this.maxBytes = options.maxBytes ?? consoleChannelMaxBytes;
  }

  get viewerCount() {
    return this.subscribers.size;
  }

  /** The sink handed to whichever producer feeds this server: a docker follow, a file tail, or a node hop. */
  upstream(): ConsoleUpstream {
    return {
      write: (chunk) => this.ingest(chunk),
      notice: (message) => this.append([`${message}\n`]),
      unavailable: (message, options) => this.publishUnavailable(message, options),
      empty: (message) => this.subscribers.forEach((subscriber) => subscriber.empty(message))
    };
  }

  /**
   * Frames raw output into whole lines. A chunk boundary lands mid-line often enough that doing
   * this anywhere else means every consumer needs its own partial-line buffer; doing it here means
   * a line is framed exactly once and carries the same number everywhere.
   */
  private ingest(chunk: string) {
    if (!chunk) return;
    const text = this.pending + chunk;
    const lastLineFeed = text.lastIndexOf("\n");
    if (lastLineFeed === -1) {
      this.pending = text;
      return;
    }
    this.pending = text.slice(lastLineFeed + 1);
    const complete = text.slice(0, lastLineFeed + 1);
    const framed = complete.split(/\r?\n/).slice(0, -1).map((line) => `${line}\n`);
    this.append(framed);
  }

  private append(texts: string[]) {
    if (!texts.length) return;
    // Output means the producer is feeding the channel again, so whatever it last failed with no
    // longer describes this console and must not be replayed to a viewer that arrives later.
    this.lastUnavailable = undefined;
    const appended: ConsoleLine[] = [];
    for (const text of texts) {
      const line = { seq: this.nextSeq, text };
      this.nextSeq += 1;
      this.lines.push(line);
      this.bufferedBytes += text.length;
      appended.push(line);
    }
    this.trim();
    this.subscribers.forEach((subscriber) => subscriber.lines(appended, this.epoch));
  }

  private trim() {
    let removed = 0;
    while (this.lines.length - removed > this.maxLines) {
      this.bufferedBytes -= this.lines[removed].text.length;
      removed += 1;
    }
    while (this.bufferedBytes > this.maxBytes && removed < this.lines.length - 1) {
      this.bufferedBytes -= this.lines[removed].text.length;
      removed += 1;
    }
    if (!removed) return;
    this.lines = this.lines.slice(removed);
    this.oldestSeq = this.lines[0]?.seq ?? this.nextSeq;
  }

  private publishUnavailable(message: string, options?: { code?: string; retryable?: boolean }) {
    this.lastUnavailable = { message, ...options };
    this.subscribers.forEach((subscriber) => subscriber.unavailable(message, options));
  }

  /** Clears a remembered failure once the producer is healthy again, so a late joiner is not told about it. */
  markAvailable() {
    this.lastUnavailable = undefined;
  }

  /**
   * What a viewer holding `cursor` still needs. `since` is the last sequence it already has, so the
   * reply starts at `since + 1`. A cursor from a different epoch describes a buffer that no longer
   * exists, so it is ignored rather than trusted, and the viewer gets everything retained.
   */
  backlog(cursor?: { since: number; epoch: ConsoleEpoch }): ConsoleBacklog {
    const resumable = cursor !== undefined && cursor.epoch === this.epoch;
    const requested = resumable ? cursor.since + 1 : this.oldestSeq;
    const from = Math.max(requested, this.oldestSeq);
    const startIndex = this.lines.findIndex((line) => line.seq >= from);
    return {
      epoch: this.epoch,
      lines: startIndex === -1 ? [] : this.lines.slice(startIndex),
      nextSeq: this.nextSeq,
      truncated: resumable && requested < this.oldestSeq
    };
  }

  subscribe(subscriber: ConsoleSubscriber) {
    this.subscribers.add(subscriber);
    if (this.lastUnavailable) {
      subscriber.unavailable(this.lastUnavailable.message, this.lastUnavailable);
    }
    return () => {
      this.subscribers.delete(subscriber);
    };
  }
}
