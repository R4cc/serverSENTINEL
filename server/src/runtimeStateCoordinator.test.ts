import { afterEach, describe, expect, it, vi } from "vitest";
import { __runtimeStateCoordinatorTestHooks, RuntimeStateCoordinator } from "./runtimeStateCoordinator.js";
import type { ManagedServer } from "./types.js";

function server(runtimeIntent?: "running" | "stopped"): ManagedServer {
  return {
    id: "server-1",
    nodeId: "node-1",
    displayName: "Survival",
    serverDir: "/data/servers/server-1",
    runtimeProfile: {
      minecraftVersion: "1.21.4",
      runtimeType: "fabric",
      runtimeVersion: "0.16.10",
      javaMajorVersion: 21,
      jarProvider: "mcjars",
      jarArtifact: { filename: "fabric-server-launch.jar" },
      compatibilityStatus: "compatible",
      resolvedAt: "2026-01-01T00:00:00.000Z"
    },
    runtimeIntent,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function status(running: boolean) {
  return { docker: { available: true, configured: true, controllable: true, running, state: running ? "running" : "exited" } };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RuntimeStateCoordinator", () => {
  it.each(["stop", "shutdown", "delete"])("discards a due recovery when %s supersedes its pending status", async (action) => {
    const managed = { ...server("running"), crashNextRetryAt: new Date(0).toISOString() };
    let release!: (value: ReturnType<typeof status>) => void;
    const pending = new Promise<ReturnType<typeof status>>((resolve) => { release = resolve; });
    const restoreServer = vi.fn(async () => status(true));
    const setLifecycle = vi.fn();
    let active = true;
    const coordinator = new RuntimeStateCoordinator({
      readServers: async () => [{ ...managed }], isServerActive: () => active,
      serverStatus: () => pending, connectionEpoch: async () => "local",
      restoreServer, setLifecycle, setRuntimeIntent: vi.fn()
    });
    const poll = coordinator.poll();
    await Promise.resolve();
    if (action === "stop") coordinator.noteStopped(managed.id);
    else if (action === "shutdown") coordinator.stop();
    else active = false;
    release(status(false));
    await poll;
    expect(restoreServer).not.toHaveBeenCalled();
    expect(setLifecycle).not.toHaveBeenCalled();
  });

  it("does not persist recovery failure after shutdown", async () => {
    const managed = { ...server("running"), crashNextRetryAt: new Date(0).toISOString() };
    let reject!: (error: Error) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const recovery = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
    const setLifecycle = vi.fn();
    const coordinator = new RuntimeStateCoordinator({
      readServers: async () => [managed], serverStatus: async () => status(false),
      connectionEpoch: async () => "local", restoreServer: () => { entered(); return recovery; },
      setLifecycle, setRuntimeIntent: vi.fn()
    });
    const poll = coordinator.poll();
    await started;
    setLifecycle.mockClear();
    coordinator.stop();
    reject(new Error("start failed"));
    await poll;
    expect(setLifecycle).not.toHaveBeenCalled();
  });
  it("treats a missing but recreatable container as authoritatively stopped", () => {
    expect(__runtimeStateCoordinatorTestHooks.authoritativeStatus({
      docker: {
        available: true,
        configured: true,
        controllable: true,
        running: false,
        state: "unknown",
        message: "Managed container is missing and will be recreated from persistent server files on start."
      }
    })).toEqual({ available: true, running: false, stopped: true });
  });

  it("initializes runtime intent from an authoritative runtime", async () => {
    const running = server();
    const stopped = { ...server(), id: "server-2" };
    const states: Array<[string, string]> = [];
    const coordinator = new RuntimeStateCoordinator({
      readServers: async () => [running, stopped],
      serverStatus: async (candidate) => status(candidate.id === running.id),
      connectionEpoch: async () => "epoch-1",
      restoreServer: async () => status(true),
      setRuntimeIntent: (id, state) => states.push([id, state])
    });

    await coordinator.poll();

    expect(states).toEqual([[running.id, "running"], [stopped.id, "stopped"]]);
  });

  it("clears a pending restart once the runtime is confirmed stopped", async () => {
    const managed = { ...server("stopped"), restartRequiredSince: "2026-01-01T00:00:00.000Z" };
    const cleared: string[] = [];
    const coordinator = new RuntimeStateCoordinator({
      readServers: async () => [managed],
      serverStatus: async () => status(false),
      connectionEpoch: async () => "epoch-1",
      restoreServer: async () => status(true),
      setRuntimeIntent: () => {},
      clearRestartRequired: (id) => cleared.push(id)
    });

    await coordinator.poll();
    await coordinator.poll();

    expect(cleared).toEqual([managed.id]);
    expect(managed.restartRequiredSince).toBeUndefined();
  });

  it("keeps a pending restart while the runtime is still running", async () => {
    const managed = { ...server("running"), restartRequiredSince: "2026-01-01T00:00:00.000Z" };
    const cleared: string[] = [];
    const coordinator = new RuntimeStateCoordinator({
      readServers: async () => [managed],
      serverStatus: async () => status(true),
      connectionEpoch: async () => "epoch-1",
      restoreServer: async () => status(true),
      setRuntimeIntent: () => {},
      setLifecycle: () => {},
      clearRestartRequired: (id) => cleared.push(id)
    });

    await coordinator.poll();

    expect(cleared).toEqual([]);
    expect(managed.restartRequiredSince).toBe("2026-01-01T00:00:00.000Z");
  });

  it("restores desired-running servers once and stops retrying after failure", async () => {
    const managed = server("running");
    const restoreServer = vi.fn().mockRejectedValue(new Error("mod crashed"));
    const states: string[] = [];
    const coordinator = new RuntimeStateCoordinator({
      readServers: async () => [managed],
      serverStatus: async () => status(false),
      connectionEpoch: async () => "epoch-1",
      restoreServer,
      setRuntimeIntent: (_id, state) => {
        states.push(state);
        managed.runtimeIntent = state;
      }
    });

    await coordinator.poll();
    await coordinator.poll();

    expect(restoreServer).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["stopped"]);
  });

  it("keeps intentionally stopped servers stopped after a new connection epoch", async () => {
    const managed = server("stopped");
    const restoreServer = vi.fn(async () => status(true));
    const coordinator = new RuntimeStateCoordinator({
      readServers: async () => [managed],
      serverStatus: async () => status(false),
      connectionEpoch: async () => "epoch-2",
      restoreServer,
      setRuntimeIntent: () => undefined
    });

    await coordinator.poll();

    expect(restoreServer).not.toHaveBeenCalled();
  });

  it("resumes a persisted intentional restart through one lifecycle owner", async () => {
    const managed = { ...server("running"), runtimeIntent: "restarting" as const, restartPhase: "stopping" as const };
    const restartServer = vi.fn(async () => status(true));
    const coordinator = new RuntimeStateCoordinator({
      readServers: async () => [managed],
      serverStatus: async () => status(true),
      connectionEpoch: async () => "epoch-1",
      restoreServer: async () => status(true),
      restartServer,
      setRuntimeIntent: () => undefined,
      setLifecycle: (_id, patch) => Object.assign(managed, patch)
    });

    await coordinator.poll();
    await coordinator.poll();

    expect(restartServer).toHaveBeenCalledTimes(1);
    expect(managed.runtimeIntent).toBe("running");
    expect(managed.restartPhase).toBeUndefined();
  });

  it("does not let an externally started container override intentional stop", async () => {
    const managed = server("stopped");
    const states: string[] = [];
    const stopServer = vi.fn(async () => status(false));
    const coordinator = new RuntimeStateCoordinator({
      readServers: async () => [managed],
      serverStatus: async () => status(true),
      connectionEpoch: async () => "epoch-1",
      restoreServer: async () => status(true),
      stopServer,
      setRuntimeIntent: (_id, state) => states.push(state)
    });

    await coordinator.poll();

    expect(states).toEqual([]);
    expect(stopServer).toHaveBeenCalledTimes(1);
  });

  it("persists a continuous-runtime exit only after confirmation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const managed = server("running");
    let running = true;
    const states: string[] = [];
    const coordinator = new RuntimeStateCoordinator({
      exitConfirmationMs: 5_000,
      readServers: async () => [managed],
      serverStatus: async () => status(running),
      connectionEpoch: async () => "epoch-1",
      restoreServer: async () => status(true),
      setRuntimeIntent: (_id, state) => {
        states.push(state);
        managed.runtimeIntent = state;
      }
    });

    await coordinator.poll();
    running = false;
    await coordinator.poll();
    expect(states).toEqual([]);
    vi.advanceTimersByTime(5_000);
    await coordinator.poll();

    expect(states).toEqual([]);
  });

  it("restarts unexpected crashes with persisted bounded backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const managed = { ...server("running"), runtimeIntent: "running" as const, crashAttemptTimestamps: [] };
    let running = true;
    const restoreServer = vi.fn(async () => status(true));
    const coordinator = new RuntimeStateCoordinator({
      exitConfirmationMs: 0,
      readServers: async () => [managed],
      serverStatus: async () => status(running),
      connectionEpoch: async () => "epoch-1",
      restoreServer,
      setRuntimeIntent: () => undefined,
      setLifecycle: (_id, patch) => Object.assign(managed, patch)
    });

    await coordinator.poll();
    running = false;
    await coordinator.poll();
    await coordinator.poll();
    expect(managed.crashNextRetryAt).toBe("2026-01-01T00:00:05.000Z");

    vi.advanceTimersByTime(5_000);
    await coordinator.poll();
    expect(restoreServer).toHaveBeenCalledTimes(1);
    expect(managed.crashAttemptTimestamps).toHaveLength(1);
  });

  it("enters crash-loop protection after the third recovery attempt fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
    const managed = {
      ...server("running"),
      runtimeIntent: "running" as const,
      crashAttemptTimestamps: ["2026-01-01T00:00:10.000Z", "2026-01-01T00:00:30.000Z"],
      crashNextRetryAt: "2026-01-01T00:01:00.000Z"
    };
    const coordinator = new RuntimeStateCoordinator({
      readServers: async () => [managed],
      serverStatus: async () => status(false),
      connectionEpoch: async () => "epoch-1",
      restoreServer: async () => { throw new Error("still crashing"); },
      setRuntimeIntent: () => undefined,
      setLifecycle: (_id, patch) => Object.assign(managed, patch)
    });

    await coordinator.poll();

    expect(managed.crashAttemptTimestamps).toHaveLength(3);
    expect(managed.crashLoopSince).toBe("2026-01-01T00:01:00.000Z");
    expect(managed.crashNextRetryAt).toBeUndefined();
  });

  it("does not reinterpret a delayed post-start crash as a recovery opportunity", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const managed = server("running");
    const restoreServer = vi.fn(async () => status(true));
    const states: string[] = [];
    const coordinator = new RuntimeStateCoordinator({
      exitConfirmationMs: 5_000,
      readServers: async () => [managed],
      serverStatus: async () => status(false),
      connectionEpoch: async () => "epoch-1",
      restoreServer,
      setRuntimeIntent: (_id, state) => states.push(state)
    });
    coordinator.noteRunning(managed.id);

    await coordinator.poll();
    vi.advanceTimersByTime(5_000);
    await coordinator.poll();

    expect(restoreServer).not.toHaveBeenCalled();
    expect(states).toEqual([]);
  });

  it("retains running intent across an outage and restores after reconnect", async () => {
    const managed = server("running");
    let mode: "running" | "offline" | "stopped" = "running";
    let epoch = "epoch-1";
    const restoreServer = vi.fn(async () => status(true));
    const coordinator = new RuntimeStateCoordinator({
      readServers: async () => [managed],
      serverStatus: async () => {
        if (mode === "offline") throw new Error("node offline");
        return status(mode === "running");
      },
      connectionEpoch: async () => epoch,
      restoreServer,
      setRuntimeIntent: (_id, state) => {
        managed.runtimeIntent = state;
      }
    });

    await coordinator.poll();
    mode = "offline";
    await coordinator.poll();
    mode = "stopped";
    epoch = "epoch-2";
    await coordinator.poll();

    expect(managed.runtimeIntent).toBe("running");
    expect(restoreServer).toHaveBeenCalledTimes(1);
  });
});
