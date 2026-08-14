/**
 * Owns one {@link ConsoleChannel} per server and decides how long it lives.
 *
 * The workload is followed once per server rather than once per viewer, so two people watching the
 * same console see identically numbered lines and a second viewer costs nothing upstream. A channel
 * outlives its last viewer by a grace window: leaving the console page and coming back is the
 * common case, and rebuilding the buffer for it is what a viewer experiences as a full redraw.
 */

import type { ConsoleBacklog, ConsoleEpoch } from "@serversentinel/contracts";
import type { ManagedServer } from "../types.js";
import {
  ConsoleChannel,
  consoleChannelIdleGraceMs,
  type ConsoleSubscriber,
  type ConsoleUpstream
} from "./consoleChannel.js";

type ConsoleUpstreamStarter = (
  server: ManagedServer,
  upstream: ConsoleUpstream
) => Promise<() => void>;

export type ConsoleCursor = { since: number; epoch: ConsoleEpoch };

type ChannelEntry = {
  channel: ConsoleChannel;
  /** In flight while the producer is being attached, so simultaneous viewers start it only once. */
  starting?: Promise<void>;
  stopUpstream?: () => void;
  idleTimer?: ReturnType<typeof setTimeout>;
};

export class ConsoleHub {
  private readonly entries = new Map<string, ChannelEntry>();

  constructor(
    private readonly startUpstream: ConsoleUpstreamStarter,
    private readonly idleGraceMs = consoleChannelIdleGraceMs
  ) {}

  /**
   * Attaches a viewer and hands back everything it is missing. The caller sends the backlog first
   * and then forwards whatever the subscriber receives, which keeps the two in order: the
   * subscriber is registered before the backlog is read, so a line arriving in between is delivered
   * rather than lost between the snapshot and the stream.
   */
  async attach(server: ManagedServer, subscriber: ConsoleSubscriber, cursor?: ConsoleCursor) {
    const entry = this.entryFor(server);
    this.cancelEviction(entry);
    // Held back until the caller has sent the backlog. The producer starts below and can deliver a
    // line before that happens, which would otherwise reach the viewer ahead of the history it
    // belongs after.
    const queued = deferUntilStarted(subscriber);
    const unsubscribe = entry.channel.subscribe(queued.subscriber);
    const backlog = entry.channel.backlog(cursor);
    await this.ensureUpstream(server, entry);
    return {
      backlog,
      /** Call once the backlog has been sent; everything the producer emitted meanwhile follows it. */
      start: queued.start,
      detach: () => {
        unsubscribe();
        this.scheduleEviction(server.id, entry);
      }
    };
  }

  /**
   * The polling fallback for viewers whose network blocks websockets. It reads the same buffer, so
   * both transports hand out the same numbered lines, and it keeps the channel alive for the same
   * grace window a websocket viewer would.
   */
  async read(server: ManagedServer, cursor?: ConsoleCursor): Promise<ConsoleBacklog> {
    const entry = this.entryFor(server);
    this.cancelEviction(entry);
    await this.ensureUpstream(server, entry);
    const backlog = entry.channel.backlog(cursor);
    this.scheduleEviction(server.id, entry);
    return backlog;
  }

  /** Drops a server's buffer outright, for deletion or shutdown. The next viewer starts a new epoch. */
  dispose(serverId: string) {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.stopUpstream?.();
    this.entries.delete(serverId);
  }

  disposeAll() {
    for (const serverId of [...this.entries.keys()]) this.dispose(serverId);
  }

  private entryFor(server: ManagedServer) {
    const existing = this.entries.get(server.id);
    if (existing) return existing;
    const entry: ChannelEntry = { channel: new ConsoleChannel() };
    this.entries.set(server.id, entry);
    return entry;
  }

  private async ensureUpstream(server: ManagedServer, entry: ChannelEntry) {
    if (entry.stopUpstream) return;
    if (entry.starting) return entry.starting;
    let ended = false;
    const upstream: ConsoleUpstream = {
      ...entry.channel.upstream(),
      // A node hop ends when the node's stream ends, which the hub is told about nowhere else.
      // Without this the producer stays recorded as live for as long as the buffer survives: the
      // next viewer attaches to a channel nothing is writing to and is handed the failure that
      // ended it, so a node that has been back for an hour still reads as offline.
      ended: () => {
        if (ended) return;
        ended = true;
        this.releaseUpstream(entry);
      }
    };
    entry.starting = this.startUpstream(server, upstream)
      .then((stop) => {
        // Nothing is left attached to feed, so release the producer rather than leaking a follow.
        // A producer that already reported itself finished — a node that was offline when the
        // stream was requested resolves with a no-op stop — must not be recorded either, or the
        // next viewer would never get a new one.
        if (!this.entries.has(server.id) || ended) {
          stop();
          return;
        }
        entry.stopUpstream = stop;
        entry.channel.markAvailable();
      })
      .catch((error: unknown) => {
        const failure = error as Error & { code?: string };
        upstream.unavailable(failure.message ?? "Console stream is unavailable.", {
          code: failure.code?.toUpperCase(),
          retryable: failure.code === "node_offline" || failure.code === "command_timeout"
        });
      })
      .finally(() => {
        entry.starting = undefined;
      });
    return entry.starting;
  }

  /**
   * Forgets the producer without dropping the buffer. The remembered failure goes with it: the
   * next viewer starts a fresh producer, and that is what decides whether the console is available
   * now, not what the previous one reported before it stopped.
   */
  private releaseUpstream(entry: ChannelEntry) {
    const stop = entry.stopUpstream;
    entry.stopUpstream = undefined;
    stop?.();
    entry.channel.markAvailable();
  }

  private cancelEviction(entry: ChannelEntry) {
    if (!entry.idleTimer) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = undefined;
  }

  private scheduleEviction(serverId: string, entry: ChannelEntry) {
    if (entry.channel.viewerCount > 0 || entry.idleTimer) return;
    entry.idleTimer = setTimeout(() => {
      entry.idleTimer = undefined;
      if (entry.channel.viewerCount > 0) return;
      this.dispose(serverId);
    }, this.idleGraceMs);
    // A pending eviction must not be what holds the process open at shutdown.
    entry.idleTimer.unref?.();
  }
}

/** Queues everything a subscriber is sent until `start()`, then replays it in arrival order. */
function deferUntilStarted(subscriber: ConsoleSubscriber) {
  let started = false;
  const pending: Array<() => void> = [];
  const run = (deliver: () => void) => {
    if (started) deliver();
    else pending.push(deliver);
  };
  return {
    subscriber: {
      lines: (lines, epoch) => run(() => subscriber.lines(lines, epoch)),
      unavailable: (message, options) => run(() => subscriber.unavailable(message, options)),
      empty: (message) => run(() => subscriber.empty(message))
    } satisfies ConsoleSubscriber,
    start: () => {
      if (started) return;
      started = true;
      for (const deliver of pending.splice(0)) deliver();
    }
  };
}
