import type { PlayerSnapshot, PlayerSnapshotErrorCode } from "./types.js";
import type { ManagedServer } from "./types.js";
import type { NodeRuntime } from "./nodes/types.js";

export type PlayerObservation =
  | {
      state: "live";
      instanceId: string;
      online: number;
      maxPlayers: number | null;
      names: string[];
      sampledAt: string;
    }
  | {
      state: "stopped";
      instanceId?: string;
      maxPlayers: number | null;
      sampledAt: string;
    }
  | {
      state: "unavailable";
      instanceId?: string;
      maxPlayers: number | null;
      attemptedAt: string;
      code: PlayerSnapshotErrorCode;
      message: string;
    };

type VerifiedSnapshot = Extract<PlayerObservation, { state: "live" }>;

type CoordinatorOptions = {
  pollMs: number;
  staleMs: number;
  readServers: () => Promise<ManagedServer[]>;
  runtimeForServer: (server: ManagedServer) => NodeRuntime;
  now?: () => number;
};

function unavailable(code: PlayerSnapshotErrorCode, message: string, attemptedAt?: string, maxPlayers: number | null = null): PlayerSnapshot {
  return {
    state: "unavailable",
    online: null,
    maxPlayers,
    names: [],
    ...(attemptedAt ? { lastAttemptAt: attemptedAt } : {}),
    code,
    message
  };
}

function validTimestamp(value: unknown) {
  return typeof value === "string" && !Number.isNaN(new Date(value).getTime());
}

function normalizeObservation(value: unknown): PlayerObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Node returned an invalid player observation");
  }
  const observation = value as Record<string, unknown>;
  if (observation.state === "stopped") {
    return {
      state: "stopped",
      instanceId: typeof observation.instanceId === "string" ? observation.instanceId : undefined,
      maxPlayers: observation.maxPlayers === null || Number.isSafeInteger(observation.maxPlayers) ? observation.maxPlayers as number | null : null,
      sampledAt: validTimestamp(observation.sampledAt) ? observation.sampledAt as string : new Date().toISOString()
    };
  }
  if (observation.state === "unavailable") {
    const allowedCodes = new Set<PlayerSnapshotErrorCode>([
      "NODE_UNAVAILABLE",
      "QUERY_DISABLED",
      "QUERY_ENDPOINT_UNAVAILABLE",
      "QUERY_TIMEOUT",
      "QUERY_RESPONSE_INCOMPLETE",
      "QUERY_RESPONSE_INVALID"
    ]);
    return {
      state: "unavailable",
      instanceId: typeof observation.instanceId === "string" ? observation.instanceId : undefined,
      maxPlayers: observation.maxPlayers === null || Number.isSafeInteger(observation.maxPlayers) ? observation.maxPlayers as number | null : null,
      attemptedAt: validTimestamp(observation.attemptedAt) ? observation.attemptedAt as string : new Date().toISOString(),
      code: allowedCodes.has(observation.code as PlayerSnapshotErrorCode) ? observation.code as PlayerSnapshotErrorCode : "NODE_UNAVAILABLE",
      message: typeof observation.message === "string" && observation.message.trim() ? observation.message.trim() : "Player data is unavailable"
    };
  }
  if (observation.state !== "live"
    || typeof observation.instanceId !== "string"
    || !observation.instanceId
    || !Number.isSafeInteger(observation.online)
    || (observation.online as number) < 0
    || !Array.isArray(observation.names)
    || observation.names.some((name) => typeof name !== "string")
    || observation.names.length !== observation.online
    || !validTimestamp(observation.sampledAt)) {
    throw new Error("Node returned an invalid complete player snapshot");
  }
  const names = (observation.names as string[]).map((name) => name.trim());
  if (names.some((name) => !name) || new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
    throw new Error("Node returned invalid player names");
  }
  const maxPlayers = observation.maxPlayers === null || Number.isSafeInteger(observation.maxPlayers)
    ? observation.maxPlayers as number | null
    : null;
  if (maxPlayers !== null && maxPlayers < observation.online) throw new Error("Node returned an invalid maximum player count");
  return {
    state: "live",
    instanceId: observation.instanceId,
    online: observation.online as number,
    maxPlayers,
    names,
    sampledAt: observation.sampledAt as string
  };
}

export class PlayerSnapshotCoordinator {
  private readonly snapshotsByServer = new Map<string, PlayerSnapshot>();
  private readonly verifiedByServer = new Map<string, VerifiedSnapshot>();
  private readonly inFlight = new Map<string, Promise<PlayerSnapshot>>();
  private readonly generations = new Map<string, number>();
  private interval: NodeJS.Timeout | undefined;

  constructor(private readonly options: CoordinatorOptions) {}

  start() {
    if (this.interval) return;
    void this.collectAll().catch(() => undefined);
    this.interval = setInterval(() => void this.collectAll().catch(() => undefined), this.options.pollMs);
    this.interval.unref?.();
  }

  stop() {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = undefined;
  }

  invalidate(serverId: string) {
    this.generations.set(serverId, (this.generations.get(serverId) ?? 0) + 1);
    this.snapshotsByServer.delete(serverId);
    this.verifiedByServer.delete(serverId);
  }

  async collectAll() {
    const servers = await this.options.readServers();
    const serverIds = new Set(servers.map((server) => server.id));
    for (const serverId of this.snapshotsByServer.keys()) {
      if (!serverIds.has(serverId)) this.invalidate(serverId);
    }
    await Promise.allSettled(servers.map((server) => this.collect(server)));
  }

  collect(server: ManagedServer) {
    const existing = this.inFlight.get(server.id);
    if (existing) return existing;
    const generation = this.generations.get(server.id) ?? 0;
    const request = this.collectOnce(server, generation).finally(() => this.inFlight.delete(server.id));
    this.inFlight.set(server.id, request);
    return request;
  }

  async snapshots(servers: ManagedServer[]) {
    const missing = servers.filter((server) => !this.snapshotsByServer.has(server.id));
    await Promise.allSettled(missing.map((server) => this.collect(server)));
    return Object.fromEntries(servers.map((server) => [server.id, this.snapshotsByServer.get(server.id)
      ?? unavailable("NODE_UNAVAILABLE", "Player data has not been collected yet")]));
  }

  async freshOnlineCount(server: ManagedServer) {
    const snapshot = await this.collect(server);
    return snapshot.state === "live" ? snapshot.online : null;
  }

  private async collectOnce(server: ManagedServer, generation: number): Promise<PlayerSnapshot> {
    try {
      const observation = normalizeObservation(await this.options.runtimeForServer(server).readPlayerObservation(server));
      if ((this.generations.get(server.id) ?? 0) !== generation) {
        return this.snapshotsByServer.get(server.id) ?? unavailable("NODE_UNAVAILABLE", "Player snapshot was invalidated during collection");
      }
      if (observation.state === "live") {
        this.verifiedByServer.set(server.id, observation);
        return this.store(server.id, {
          state: "live",
          online: observation.online,
          maxPlayers: observation.maxPlayers,
          names: observation.names,
          sampledAt: observation.sampledAt
        });
      }
      if (observation.state === "stopped") {
        this.verifiedByServer.delete(server.id);
        return this.store(server.id, {
          state: "stopped",
          online: 0,
          maxPlayers: observation.maxPlayers,
          names: [],
          sampledAt: observation.sampledAt
        });
      }
      return this.failed(server.id, observation.code, observation.message, observation.attemptedAt, observation.maxPlayers, observation.instanceId);
    } catch (error) {
      if ((this.generations.get(server.id) ?? 0) !== generation) {
        return this.snapshotsByServer.get(server.id) ?? unavailable("NODE_UNAVAILABLE", "Player snapshot was invalidated during collection");
      }
      return this.failed(server.id, "NODE_UNAVAILABLE", error instanceof Error ? error.message : "Node is unavailable", new Date(this.now()).toISOString());
    }
  }

  private failed(
    serverId: string,
    code: PlayerSnapshotErrorCode,
    message: string,
    attemptedAt: string,
    maxPlayers: number | null = null,
    instanceId?: string
  ) {
    const verified = this.verifiedByServer.get(serverId);
    const verifiedAt = verified ? new Date(verified.sampledAt).getTime() : Number.NaN;
    const sameInstance = !instanceId || verified?.instanceId === instanceId;
    if (verified && sameInstance && this.now() - verifiedAt <= this.options.staleMs) {
      return this.store(serverId, {
        state: "stale",
        online: verified.online,
        maxPlayers: verified.maxPlayers,
        names: verified.names,
        sampledAt: verified.sampledAt,
        lastAttemptAt: attemptedAt,
        code,
        message
      });
    }
    if (!sameInstance || verified && this.now() - verifiedAt > this.options.staleMs) this.verifiedByServer.delete(serverId);
    return this.store(serverId, unavailable(code, message, attemptedAt, maxPlayers));
  }

  private store(serverId: string, snapshot: PlayerSnapshot) {
    this.snapshotsByServer.set(serverId, snapshot);
    return snapshot;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }
}
