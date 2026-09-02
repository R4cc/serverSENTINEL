import type { ManagedServer } from "../types.js";
import type { PlayerGeoRepository } from "../storage/playerGeoRepository.js";
import { isLocatableAddress, locateAddress, type GeoCityReader } from "./geoLocation.js";
import { parsePlayerLoginAddresses } from "./loginAddresses.js";
import type { PlayerLoginAddress } from "./loginAddresses.js";

/**
 * The only code that ever looks at a player's address.
 *
 * It does not fetch anything. The panel already reads each server's recent console output once a
 * pass, for the timeline, and this subscribes to that same text rather than asking the node for it
 * a second time. What it adds is one parsing pass over login lines: each address is resolved against
 * the local GeoLite2 database and the same ephemeral endpoint is offered to the module's TCP ping
 * collector. Only the derived place is written; the ping collector keeps the endpoint in memory
 * only while that player is connected, and neither collector logs or publicly exposes it.
 *
 * Subscribing is therefore the whole of the module's gate. With Player Insights switched off the
 * subscription is gone, so no login line is parsed, no address is resolved, and nothing is written
 * — while the timeline keeps reading the same logs it always did, for its own reasons.
 */

/** Retention for derived geography. Timeline history is a week, so this is generous by design. */
export const playerGeoRetentionMs = 90 * 24 * 60 * 60 * 1000;
/** Pruning and forgetting deleted servers are housekeeping, not a poll; hourly is plenty. */
export const playerGeoMaintenanceIntervalMs = 60 * 60 * 1000;

type ObservedLogs = {
  server: ManagedServer;
  text: string;
};

type PlayerGeoCollectorOptions = {
  /** Subscribes to the console output the timeline collector already reads. Returns unsubscribe. */
  observeLogs(observer: (input: ObservedLogs) => void | Promise<void>): () => void;
  repository: PlayerGeoRepository;
  /** Undefined while no database is loaded, in which case nothing is resolved and nothing stored. */
  cityReader(): GeoCityReader | undefined;
  /** Receives the same ephemeral login once so another Player Insights collector need not reparse logs. */
  observeLogin?(server: ManagedServer, login: PlayerLoginAddress): void;
  /** The servers this installation still has, read from local storage rather than from a node. */
  readServers?(): Promise<ManagedServer[]>;
  retainServers?(serverIds: string[]): void;
  retentionMs?: number;
  maintenanceIntervalMs?: number;
  now?(): number;
  onError?(error: unknown, server?: ManagedServer): void;
};

export class PlayerGeoCollector {
  private unsubscribe: (() => void) | undefined;
  private lastMaintenanceAt = 0;
  private maintaining = false;
  /** Set by `stop`, and read mid-pass: an observation already under way must not write after it. */
  private stopped = false;

  constructor(private readonly options: PlayerGeoCollectorOptions) {}

  start() {
    if (this.unsubscribe) return;
    this.stopped = false;
    this.unsubscribe = this.options.observeLogs((input) => this.observe(input));
  }

  stop() {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** One pass over one server's console output. Public so tests can drive it directly. */
  async observe({ server, text }: ObservedLogs) {
    if (this.stopped || !text) return;
    const reader = this.options.cityReader();
    try {
      const referenceDate = new Date(this.now());
      for (const login of parsePlayerLoginAddresses(text, referenceDate)) {
        if (this.stopped) return;
        this.options.observeLogin?.(server, login);
        if (!reader) continue;
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
    await this.maintain();
  }

  /**
   * Prunes stale geography and forgets servers this installation no longer has.
   *
   * Driven off the observation pass rather than a timer of its own — there is nothing to maintain
   * on an installation whose logs are never read — and rate limited, because the pass itself runs
   * every few seconds and this touches the whole table.
   */
  private async maintain() {
    const interval = this.options.maintenanceIntervalMs ?? playerGeoMaintenanceIntervalMs;
    if (this.maintaining || this.now() - this.lastMaintenanceAt < interval) return;
    this.maintaining = true;
    this.lastMaintenanceAt = this.now();
    try {
      this.options.repository.prune(this.now() - (this.options.retentionMs ?? playerGeoRetentionMs));
      if (this.options.readServers && this.options.retainServers) {
        const servers = await this.options.readServers();
        if (!this.stopped) this.options.retainServers(servers.map((server) => server.id));
      }
    } catch (error) {
      this.options.onError?.(error);
    } finally {
      this.maintaining = false;
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}
