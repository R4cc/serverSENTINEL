import type { ManagedServer } from "./types.js";

type RuntimeStatus = {
  docker?: {
    available?: boolean;
    controllable?: boolean;
    configured?: boolean;
    running?: boolean;
    state?: string;
    message?: string;
  };
};

type RuntimeObservation = {
  epoch?: string;
  unavailable: boolean;
  observedRunning: boolean;
  restoreAttempted: boolean;
  pendingExitAt?: number;
  explicitObservation: boolean;
  inFlight: boolean;
};

export type RuntimeStateCoordinatorOptions = {
  pollMs?: number;
  exitConfirmationMs?: number;
  readServers: () => Promise<ManagedServer[]>;
  serverStatus: (server: ManagedServer) => Promise<unknown>;
  connectionEpoch: (server: ManagedServer) => Promise<string>;
  canRestore?: (server: ManagedServer) => boolean;
  restoreServer: (server: ManagedServer) => Promise<unknown>;
  setDesiredState: (serverId: string, state: "running" | "stopped") => void;
  onError?: (error: unknown, server?: ManagedServer) => void;
};

const stoppedStates = new Set(["created", "dead", "exited"]);

function runningFromStatus(value: unknown) {
  if (!value || typeof value !== "object") return false;
  const status = value as RuntimeStatus & { running?: boolean };
  return status.running === true || status.docker?.running === true;
}

function authoritativeStatus(value: unknown) {
  const status = value && typeof value === "object" ? value as RuntimeStatus : {};
  const docker = status.docker;
  if (!docker || docker.available !== true) return { available: false, running: false, stopped: false };
  if (docker.running === true) return { available: true, running: true, stopped: false };
  const state = typeof docker.state === "string" ? docker.state : "";
  const message = typeof docker.message === "string" ? docker.message : "";
  const stopped = stoppedStates.has(state)
    || (state === "unknown" && /container (?:will be created|not found|does not exist)|configured container does not exist/i.test(message));
  return { available: true, running: false, stopped };
}

export class RuntimeStateCoordinator {
  private readonly pollMs: number;
  private readonly exitConfirmationMs: number;
  private readonly observations = new Map<string, RuntimeObservation>();
  private interval?: NodeJS.Timeout;
  private closed = false;

  constructor(private readonly options: RuntimeStateCoordinatorOptions) {
    this.pollMs = options.pollMs ?? 5_000;
    this.exitConfirmationMs = options.exitConfirmationMs ?? 5_000;
  }

  start() {
    if (this.interval || this.closed) return;
    void this.poll();
    this.interval = setInterval(() => void this.poll(), this.pollMs);
    this.interval.unref?.();
  }

  stop() {
    this.closed = true;
    if (this.interval) clearInterval(this.interval);
    this.interval = undefined;
    this.observations.clear();
  }

  noteRunning(serverId: string) {
    const observation = this.observation(serverId);
    observation.observedRunning = true;
    observation.restoreAttempted = true;
    observation.pendingExitAt = undefined;
    observation.unavailable = false;
    observation.explicitObservation = true;
  }

  noteStopped(serverId: string) {
    const observation = this.observation(serverId);
    observation.observedRunning = false;
    observation.restoreAttempted = true;
    observation.pendingExitAt = undefined;
    observation.explicitObservation = true;
  }

  async poll() {
    if (this.closed) return;
    let servers: ManagedServer[];
    try {
      servers = await this.options.readServers();
    } catch (error) {
      this.options.onError?.(error);
      return;
    }
    const activeIds = new Set(servers.map((server) => server.id));
    for (const id of this.observations.keys()) {
      if (!activeIds.has(id)) this.observations.delete(id);
    }
    await Promise.allSettled(servers.map((server) => this.reconcileLocked(server)));
  }

  private observation(serverId: string) {
    const current = this.observations.get(serverId);
    if (current) return current;
    const created: RuntimeObservation = {
      unavailable: true,
      observedRunning: false,
      restoreAttempted: false,
      explicitObservation: false,
      inFlight: false
    };
    this.observations.set(serverId, created);
    return created;
  }

  private async reconcileLocked(server: ManagedServer) {
    const observation = this.observation(server.id);
    if (observation.inFlight) return;
    observation.inFlight = true;
    try {
      await this.reconcile(server, observation);
    } catch (error) {
      observation.unavailable = true;
      observation.pendingExitAt = undefined;
      this.options.onError?.(error, server);
    } finally {
      observation.inFlight = false;
    }
  }

  private async reconcile(server: ManagedServer, observation: RuntimeObservation) {
    const [status, epoch] = await Promise.all([
      this.options.serverStatus(server),
      this.options.connectionEpoch(server)
    ]);
    const actual = authoritativeStatus(status);
    if (!actual.available || (!actual.running && !actual.stopped)) {
      observation.unavailable = true;
      observation.pendingExitAt = undefined;
      return;
    }

    if (observation.unavailable || observation.epoch !== epoch) {
      const preserveExplicitObservation = observation.explicitObservation;
      observation.epoch = epoch;
      observation.unavailable = false;
      observation.observedRunning = preserveExplicitObservation && observation.observedRunning;
      observation.restoreAttempted = preserveExplicitObservation;
      observation.pendingExitAt = undefined;
      observation.explicitObservation = false;
    }

    if (actual.running) {
      if (server.desiredRuntimeState !== "running") this.options.setDesiredState(server.id, "running");
      observation.observedRunning = true;
      observation.restoreAttempted = true;
      observation.pendingExitAt = undefined;
      return;
    }

    if (!server.desiredRuntimeState) {
      this.options.setDesiredState(server.id, "stopped");
      observation.observedRunning = false;
      observation.restoreAttempted = true;
      return;
    }
    if (server.desiredRuntimeState === "stopped") {
      observation.observedRunning = false;
      observation.restoreAttempted = true;
      observation.pendingExitAt = undefined;
      return;
    }

    if (!observation.observedRunning) {
      if (observation.restoreAttempted || this.options.canRestore?.(server) === false) return;
      observation.restoreAttempted = true;
      try {
        const result = await this.options.restoreServer(server);
        if (!runningFromStatus(result)) throw new Error("Restored Minecraft runtime did not remain running");
        observation.observedRunning = true;
        observation.pendingExitAt = undefined;
      } catch (error) {
        this.options.setDesiredState(server.id, "stopped");
        observation.observedRunning = false;
        this.options.onError?.(error, server);
      }
      return;
    }

    const now = Date.now();
    if (observation.pendingExitAt === undefined) {
      observation.pendingExitAt = now;
      return;
    }
    if (now - observation.pendingExitAt < this.exitConfirmationMs) return;
    this.options.setDesiredState(server.id, "stopped");
    observation.observedRunning = false;
    observation.restoreAttempted = true;
    observation.pendingExitAt = undefined;
  }
}

export const __runtimeStateCoordinatorTestHooks = { authoritativeStatus, runningFromStatus };
