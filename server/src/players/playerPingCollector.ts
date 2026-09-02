import { SocketAddress } from "node:net";
import type { PlayerPingMeasurement, PlayerSnapshot } from "@serversentinel/contracts";
import type { ManagedServer } from "../types.js";
import { playerGeoKey } from "../storage/playerGeoRepository.js";
import type { PlayerLoginAddress } from "./loginAddresses.js";
import type { PlayerConnectionObservation, PlayerTcpConnection } from "./dockerPlayerConnections.js";

export const playerPingPollMs = 10_000;
const maxFreshPingAgeMs = 15_000;

type PlayerEndpoint = { address: string; port: number };
type CurrentPings = { sampledAt: number; values: Map<string, number> };

type PlayerPingCollectorOptions = {
  readServers(): Promise<ManagedServer[]>;
  snapshot(serverId: string): PlayerSnapshot | undefined;
  readConnections(server: ManagedServer): Promise<PlayerConnectionObservation>;
  pollMs?: number;
  now?(): number;
  onError?(error: unknown, server?: ManagedServer): void;
};

/** Canonical comparison form only; this value never leaves the module-owned in-memory tracker. */
export function normalizeConnectionAddress(value: string) {
  const raw = value.trim().replace(/^\[|\]$/g, "");
  const address = raw.includes(":") ? raw.split("%", 1)[0] : raw;
  const parsed = SocketAddress.parse(address.includes(":") ? `[${address}]` : address);
  return parsed?.address.startsWith("::ffff:") ? parsed.address.slice(7) : parsed?.address;
}

function connectionKey(address: string, port: number) {
  return `${address}|${port}`;
}

function safeConnections(observation: PlayerConnectionObservation): PlayerTcpConnection[] {
  if (observation.status !== "available" || !Array.isArray(observation.connections)) return [];
  return observation.connections.filter((connection) => {
    return typeof connection.remoteAddress === "string"
      && Number.isInteger(connection.remotePort) && connection.remotePort > 0 && connection.remotePort <= 65_535
      && Number.isFinite(connection.rttUs) && connection.rttUs > 0 && connection.rttUs <= 60_000_000;
  });
}

export class PlayerPingCollector {
  private readonly endpoints = new Map<string, Map<string, PlayerEndpoint>>();
  private readonly pings = new Map<string, CurrentPings>();
  private readonly states = new Map<string, PlayerPingMeasurement>();
  private readonly instances = new Map<string, string>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private interval: NodeJS.Timeout | undefined;
  private generation = 0;

  constructor(private readonly options: PlayerPingCollectorOptions) {}

  start() {
    if (this.interval) return;
    this.generation += 1;
    void this.collectAll();
    this.interval = setInterval(() => void this.collectAll(), this.options.pollMs ?? playerPingPollMs);
    this.interval.unref?.();
  }

  stop() {
    this.generation += 1;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    this.endpoints.clear();
    this.pings.clear();
    this.states.clear();
    this.instances.clear();
  }

  observeLogin(server: ManagedServer, login: PlayerLoginAddress) {
    if (!this.interval) return;
    const playerKey = playerGeoKey(login.player);
    if (!playerKey) return;
    const address = normalizeConnectionAddress(login.address);
    const endpoints = this.endpoints.get(server.id) ?? new Map<string, PlayerEndpoint>();
    const previous = endpoints.get(playerKey);
    if (!address || !login.port) {
      endpoints.delete(playerKey);
      this.clearPlayerPing(server.id, playerKey);
      return;
    }
    if (previous && (previous.address !== address || previous.port !== login.port)) {
      this.clearPlayerPing(server.id, playerKey);
    }
    endpoints.set(playerKey, { address, port: login.port });
    this.endpoints.set(server.id, endpoints);
  }

  latest(serverId: string) {
    const current = this.pings.get(serverId);
    if (!current || this.now() - current.sampledAt > maxFreshPingAgeMs) return new Map<string, number>();
    return new Map(current.values);
  }

  measurements(serverIds: readonly string[]) {
    return serverIds.map((serverId) => this.states.get(serverId) ?? {
      serverId,
      status: "idle" as const,
      onlinePlayers: 0,
      measuredPlayers: 0
    });
  }

  async collectAll() {
    const generation = this.generation;
    try {
      const servers = await this.options.readServers();
      if (generation !== this.generation) return;
      const active = new Set(servers.map((server) => server.id));
      for (const store of [this.endpoints, this.pings, this.states, this.instances]) {
        for (const serverId of store.keys()) if (!active.has(serverId)) store.delete(serverId);
      }
      await Promise.allSettled(servers.map((server) => this.collect(server, generation)));
    } catch {
      this.options.onError?.(new Error("Player ping collection failed"));
    }
  }

  private collect(server: ManagedServer, generation: number) {
    const existing = this.inFlight.get(server.id);
    if (existing) return existing;
    const request = this.collectOnce(server, generation).finally(() => this.inFlight.delete(server.id));
    this.inFlight.set(server.id, request);
    return request;
  }

  private async collectOnce(server: ManagedServer, generation: number) {
    const snapshot = this.options.snapshot(server.id);
    const onlineNames = snapshot && (snapshot.state === "live" || snapshot.state === "stale") ? snapshot.names : [];
    const online = new Set(onlineNames.map(playerGeoKey));
    const endpoints = this.endpoints.get(server.id);
    if (endpoints) for (const player of endpoints.keys()) if (!online.has(player)) endpoints.delete(player);
    if (onlineNames.length === 0) {
      this.pings.delete(server.id);
      this.states.set(server.id, {
        serverId: server.id,
        status: "idle",
        onlinePlayers: 0,
        measuredPlayers: 0,
        sampledAt: new Date(this.now()).toISOString()
      });
      return;
    }

    try {
      const observation = await this.options.readConnections(server);
      if (generation !== this.generation) return;
      const previousInstance = this.instances.get(server.id);
      if (observation.instanceId && previousInstance && previousInstance !== observation.instanceId) {
        this.endpoints.delete(server.id);
        this.pings.delete(server.id);
      }
      if (observation.instanceId) this.instances.set(server.id, observation.instanceId);

      if (observation.status !== "available") {
        this.pings.delete(server.id);
        if (observation.status === "idle") {
          this.endpoints.delete(server.id);
          this.instances.delete(server.id);
        }
        const status = observation.status === "unsupported" ? "unsupported" : observation.status === "idle" ? "idle" : "unavailable";
        this.states.set(server.id, {
          serverId: server.id,
          status,
          onlinePlayers: onlineNames.length,
          measuredPlayers: 0,
          sampledAt: new Date(this.now()).toISOString()
        });
        return;
      }

      const connections = new Map<string, number>();
      for (const connection of safeConnections(observation)) {
        const address = normalizeConnectionAddress(connection.remoteAddress);
        if (address) connections.set(connectionKey(address, connection.remotePort), connection.rttUs);
      }
      const values = new Map<string, number>();
      for (const player of online) {
        const endpoint = this.endpoints.get(server.id)?.get(player);
        if (!endpoint) continue;
        const rttUs = connections.get(connectionKey(endpoint.address, endpoint.port));
        if (rttUs !== undefined) values.set(player, Math.max(1, Math.round(rttUs / 1000)));
      }
      // Freshness follows the panel's receipt time, not a remote node clock that may be skewed.
      const sampledAt = this.now();
      this.pings.set(server.id, { sampledAt, values });
      this.states.set(server.id, {
        serverId: server.id,
        status: "available",
        onlinePlayers: onlineNames.length,
        measuredPlayers: values.size,
        sampledAt: new Date(sampledAt).toISOString()
      });
    } catch {
      if (generation !== this.generation) return;
      this.pings.delete(server.id);
      this.states.set(server.id, {
        serverId: server.id,
        status: "unavailable",
        onlinePlayers: onlineNames.length,
        measuredPlayers: 0,
        sampledAt: new Date(this.now()).toISOString()
      });
      this.options.onError?.(new Error("Player ping measurement failed"), server);
    }
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  private clearPlayerPing(serverId: string, playerKey: string) {
    const current = this.pings.get(serverId);
    if (!current) return;
    current.values.delete(playerKey);
    if (current.values.size === 0) this.pings.delete(serverId);
  }
}
