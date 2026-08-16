import type { ManagedServer } from "../types.js";
import type { PlayerGeoRepository } from "../storage/playerGeoRepository.js";
import { isLocatableAddress, locateAddress, type GeoCityReader } from "./geoLocation.js";
import { parsePlayerLoginAddresses } from "./loginAddresses.js";

/**
 * The only background work that ever sees a player's address.
 *
 * It reads the same recent console output the timeline collector already polls, finds the login
 * lines, resolves each address against the local GeoLite2 database, and writes the place. The
 * address exists as a local variable for the length of one lookup and is never handed to anything
 * that persists, logs, or transmits it — which is why this loop is the module's whole exposure and
 * why switching the module off is enough to stop it entirely.
 */

export const playerGeoPollIntervalMs = 15_000;
/** Geography older than this stops describing who plays here, and is dropped. */
export const playerGeoRetentionMs = 90 * 24 * 60 * 60 * 1000;

type RecentLogs = { text?: string };

type PlayerGeoCollectorOptions = {
  intervalMs?: number;
  retentionMs?: number;
  readServers(): Promise<ManagedServer[]>;
  readLogs(server: ManagedServer): Promise<unknown>;
  repository: PlayerGeoRepository;
  /** Undefined while no database is loaded, in which case nothing is resolved and nothing stored. */
  cityReader(): GeoCityReader | undefined;
  retainServers?(serverIds: string[]): void;
  now?(): number;
  onError?(error: unknown, server?: ManagedServer): void;
};

export class PlayerGeoCollector {
  private readonly inFlight = new Map<string, Promise<void>>();
  private timer: NodeJS.Timeout | undefined;
  /** Set by `stop`, and read mid-pass: a poll already under way must not write after the switch moves. */
  private stopped = false;

  constructor(private readonly options: PlayerGeoCollectorOptions) {}

  start() {
    if (this.timer) return;
    this.stopped = false;
    void this.collectAll();
    this.timer = setInterval(() => void this.collectAll(), this.options.intervalMs ?? playerGeoPollIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async collectAll() {
    try {
      const servers = await this.options.readServers();
      this.options.retainServers?.(servers.map((server) => server.id));
      await Promise.allSettled(servers.map((server) => this.collectServer(server)));
      this.options.repository.prune(this.now() - (this.options.retentionMs ?? playerGeoRetentionMs));
    } catch (error) {
      this.options.onError?.(error);
    }
  }

  collectServer(server: ManagedServer) {
    const existing = this.inFlight.get(server.id);
    if (existing) return existing;
    const request = this.collectServerOnce(server).finally(() => this.inFlight.delete(server.id));
    this.inFlight.set(server.id, request);
    return request;
  }

  private async collectServerOnce(server: ManagedServer) {
    // No database means no lookups: reading the log at all would only expose addresses this module
    // has no use for, so the poll is skipped rather than parsed and discarded.
    const reader = this.options.cityReader();
    if (!reader || this.stopped) return;
    try {
      const result = await this.options.readLogs(server) as RecentLogs;
      const text = typeof result?.text === "string" ? result.text : "";
      if (!text) return;
      const referenceDate = new Date(this.now());
      for (const login of parsePlayerLoginAddresses(text, referenceDate)) {
        if (this.stopped) return;
        if (!isLocatableAddress(login.address)) continue;
        const location = locateAddress(reader, login.address);
        if (!location) continue;
        const at = login.at ? Date.parse(login.at) : Number.NaN;
        this.options.repository.record({
          serverId: server.id,
          player: login.player,
          location,
          at: Number.isFinite(at) ? at : this.now()
        });
      }
    } catch (error) {
      this.options.onError?.(error, server);
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}
