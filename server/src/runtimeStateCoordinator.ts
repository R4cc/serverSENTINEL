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
  setLifecycle?: (serverId: string, patch: Partial<ManagedServer>) => void;
  restartServer?: (server: ManagedServer) => Promise<unknown>;
  stopServer?: (server: ManagedServer) => Promise<unknown>;
  onError?: (error: unknown, server?: ManagedServer) => void;
};

const stoppedStates = new Set(["created", "dead", "exited"]);
export const crashRetryDelaysMs = [5_000, 15_000, 30_000] as const;
export const crashRetryWindowMs = 10 * 60_000;

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
    || (state === "unknown" && (
      (docker.configured === true && docker.controllable === true)
      || /container (?:will be created|not found|does not exist)|configured container does not exist/i.test(message)
    ));
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

    const intent = server.runtimeIntent ?? server.desiredRuntimeState ?? undefined;
    if (actual.running) {
      if (intent === "restarting") {
        if (server.restartPhase === "stopping" && !observation.restoreAttempted && this.options.restartServer && this.options.canRestore?.(server) !== false) {
          observation.restoreAttempted = true;
          const result = await this.options.restartServer(server);
          if (!runningFromStatus(result)) throw new Error("Resumed restart did not remain running");
          this.persistLifecycle(server, { runtimeIntent: "running", restartPhase: undefined, crashStableSince: new Date().toISOString() });
        } else if (server.restartPhase === "starting") {
          this.persistLifecycle(server, { runtimeIntent: "running", restartPhase: undefined, crashStableSince: new Date().toISOString() });
        }
        observation.observedRunning = true;
        observation.pendingExitAt = undefined;
        return;
      }
      if (intent === "stopped") {
        if (!observation.restoreAttempted && this.options.stopServer && this.options.canRestore?.(server) !== false) {
          observation.restoreAttempted = true;
          await this.options.stopServer(server);
        }
        observation.observedRunning = false;
        observation.pendingExitAt = undefined;
        return;
      }
      if (intent !== "running") {
        this.persistLifecycle(server, { runtimeIntent: "running" });
      }
      const stableSince = server.crashStableSince ? Date.parse(server.crashStableSince) : Date.now();
      if (!server.crashStableSince) this.persistLifecycle(server, { crashStableSince: new Date().toISOString() });
      if ((server.crashAttemptTimestamps?.length || server.crashNextRetryAt || server.crashLoopSince) && Date.now() - stableSince >= crashRetryWindowMs) {
        this.persistLifecycle(server, { crashAttemptTimestamps: [], crashNextRetryAt: undefined, crashLoopSince: undefined, crashStableSince: new Date().toISOString() });
      }
      observation.observedRunning = true;
      observation.restoreAttempted = true;
      observation.pendingExitAt = undefined;
      return;
    }

    if (!intent) {
      this.persistLifecycle(server, { runtimeIntent: "stopped" });
      observation.observedRunning = false;
      observation.restoreAttempted = true;
      return;
    }
    if (intent === "stopped") {
      observation.observedRunning = false;
      observation.restoreAttempted = true;
      observation.pendingExitAt = undefined;
      return;
    }

    if (intent === "restarting") {
      if (observation.restoreAttempted || this.options.canRestore?.(server) === false || !this.options.restartServer) return;
      observation.restoreAttempted = true;
      const result = await this.options.restartServer(server);
      if (!runningFromStatus(result)) throw new Error("Resumed restart did not remain running");
      this.persistLifecycle(server, { runtimeIntent: "running", restartPhase: undefined, crashStableSince: new Date().toISOString() });
      observation.observedRunning = true;
      return;
    }

    if (server.crashLoopSince) {
      observation.observedRunning = false;
      observation.restoreAttempted = true;
      return;
    }

    if (server.crashNextRetryAt || (server.crashAttemptTimestamps?.length ?? 0) > 0) {
      await this.recoverCrash(server, observation);
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
        this.persistLifecycle(server, { runtimeIntent: "stopped" });
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
    const attempts = this.recentCrashAttempts(server);
    if (attempts.length >= crashRetryDelaysMs.length) {
      this.persistLifecycle(server, { crashAttemptTimestamps: attempts, crashNextRetryAt: undefined, crashLoopSince: new Date(now).toISOString(), crashStableSince: undefined });
    } else {
      this.persistLifecycle(server, {
        crashAttemptTimestamps: attempts,
        crashNextRetryAt: new Date(now + crashRetryDelaysMs[attempts.length]).toISOString(),
        crashStableSince: undefined
      });
    }
    observation.observedRunning = false;
    observation.restoreAttempted = false;
    observation.pendingExitAt = undefined;
  }

  private recentCrashAttempts(server: ManagedServer) {
    const threshold = Date.now() - crashRetryWindowMs;
    return (server.crashAttemptTimestamps ?? []).filter((value) => {
      const at = Date.parse(value);
      return Number.isFinite(at) && at >= threshold;
    });
  }

  private async recoverCrash(server: ManagedServer, observation: RuntimeObservation) {
    const attempts = this.recentCrashAttempts(server);
    if (attempts.length >= crashRetryDelaysMs.length && !server.crashNextRetryAt) {
      this.persistLifecycle(server, { crashAttemptTimestamps: attempts, crashLoopSince: new Date().toISOString(), crashStableSince: undefined });
      observation.restoreAttempted = true;
      return;
    }
    const retryAt = server.crashNextRetryAt ? Date.parse(server.crashNextRetryAt) : Date.now() + crashRetryDelaysMs[Math.min(attempts.length, crashRetryDelaysMs.length - 1)];
    if (!server.crashNextRetryAt) this.persistLifecycle(server, { crashNextRetryAt: new Date(retryAt).toISOString() });
    if (Date.now() < retryAt || this.options.canRestore?.(server) === false) return;

    const nextAttempts = [...attempts, new Date().toISOString()];
    this.persistLifecycle(server, { crashAttemptTimestamps: nextAttempts, crashNextRetryAt: undefined });
    try {
      const result = await this.options.restoreServer(server);
      if (!runningFromStatus(result)) throw new Error("Crash recovery did not remain running");
      this.persistLifecycle(server, { crashStableSince: new Date().toISOString() });
      observation.observedRunning = true;
      observation.restoreAttempted = false;
      observation.pendingExitAt = undefined;
    } catch (error) {
      if (nextAttempts.length >= crashRetryDelaysMs.length) {
        this.persistLifecycle(server, { crashLoopSince: new Date().toISOString(), crashNextRetryAt: undefined, crashStableSince: undefined });
      } else {
        this.persistLifecycle(server, { crashNextRetryAt: new Date(Date.now() + crashRetryDelaysMs[nextAttempts.length]).toISOString() });
      }
      this.options.onError?.(error, server);
    }
  }

  private persistLifecycle(server: ManagedServer, patch: Partial<ManagedServer>) {
    Object.assign(server, patch);
    if (patch.runtimeIntent) server.desiredRuntimeState = patch.runtimeIntent === "stopped" ? "stopped" : "running";
    if (this.options.setLifecycle) this.options.setLifecycle(server.id, patch);
    else if (patch.runtimeIntent) this.options.setDesiredState(server.id, patch.runtimeIntent === "stopped" ? "stopped" : "running");
  }
}

export const __runtimeStateCoordinatorTestHooks = { authoritativeStatus, runningFromStatus };
