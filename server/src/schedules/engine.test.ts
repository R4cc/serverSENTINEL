import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedServer, OperationRecord, ScheduledExecution } from "../types.js";

const operationsRepository = {
  create: vi.fn((input: Record<string, unknown>) => ({ id: "operation-1", status: "queued", ...input } as unknown as OperationRecord)),
  find: vi.fn(),
  start: vi.fn(),
  update: vi.fn(),
  cancel: vi.fn(),
  fail: vi.fn(),
  succeed: vi.fn()
};
const serversRepository = { find: vi.fn(), recordScheduledRun: vi.fn() };
const serverStatus = vi.fn(async () => ({ docker: { running: true } }));
const sendConsoleCommand = vi.fn(async () => ({}));
const freshOnlineCount = vi.fn(async (): Promise<number | null> => 0);
const exportCoordinator = {
  activeOperationId: vi.fn((): string | undefined => undefined),
  assertMutationAllowed: vi.fn(),
  withMutation: vi.fn(async (_serverId: string, action: () => Promise<unknown>) => action())
};

vi.mock("../appServices.js", () => ({
  services: { operationsRepository, serversRepository, exportCoordinator, playerSnapshotCoordinator: { freshOnlineCount } },
  runtimeForServer: () => ({ serverStatus, sendConsoleCommand, serverLogs: async () => ({ text: "" }) })
}));

const { executeMatchedSchedule, resumableScheduleWaitOperations, resumeWaitingScheduleExecutions, scheduleFromBody, scheduleRequiresRunningServer, startScheduleExecution, waitUntilServerIsEmpty } = await import("./engine.js");
const { activeScheduleExecutions, cancelActiveScheduleRunsForSchedule, runningSchedules } = await import("./activeRuns.js");

const server = { id: "server-1", nodeId: "local", displayName: "Survival" } as ManagedServer;
const schedule: ScheduledExecution = {
  id: "schedule-1",
  name: "Nightly restart",
  cron: "0 4 * * *",
  steps: [],
  onlyWhenNoPlayers: false,
  waitForPlayersToLeave: false,
  enabled: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z"
};

describe("scheduled run bookkeeping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeScheduleExecutions.clear();
    runningSchedules.clear();
    serverStatus.mockResolvedValue({ docker: { running: true } });
    freshOnlineCount.mockResolvedValue(0);
    exportCoordinator.activeOperationId.mockReturnValue(undefined);
    exportCoordinator.withMutation.mockImplementation(async (_serverId: string, action: () => Promise<unknown>) => action());
    operationsRepository.find.mockReturnValue(undefined);
    serversRepository.find.mockReturnValue(undefined);
  });

  it("clears the active run and resolves the operation after a successful run", async () => {
    await executeMatchedSchedule(server, schedule);

    expect(activeScheduleExecutions.size).toBe(0);
    expect(serversRepository.recordScheduledRun).toHaveBeenCalledTimes(1);
    expect(operationsRepository.succeed).toHaveBeenCalledTimes(1);
  });

  it("normalizes the wait policy as a no-player requirement", () => {
    const parsed = scheduleFromBody({
      name: "Wait for maintenance",
      cron: "0 4 * * *",
      steps: [{ type: "command", command: "save-all", delaySeconds: 0 }],
      onlyWhenNoPlayers: false,
      waitForPlayersToLeave: true,
      enabled: true
    });

    expect(parsed).toMatchObject({ onlyWhenNoPlayers: true, waitForPlayersToLeave: true });
  });

  it("clears the active run and still resolves the operation when history cannot be persisted", async () => {
    serversRepository.recordScheduledRun.mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    await expect(executeMatchedSchedule(server, schedule)).resolves.toBeUndefined();

    // A stranded entry would keep the schedule reported as running forever.
    expect(activeScheduleExecutions.size).toBe(0);
    expect(operationsRepository.succeed).toHaveBeenCalledTimes(1);
  });

  it("waits outside the mutation lock until the server is empty", async () => {
    let releasePlayerCheck: ((count: number) => void) | undefined;
    freshOnlineCount.mockImplementationOnce(() => new Promise<number>((resolve) => { releasePlayerCheck = resolve; }));

    const waiting = executeMatchedSchedule(server, { ...schedule, onlyWhenNoPlayers: true, waitForPlayersToLeave: true });
    await vi.waitFor(() => expect(freshOnlineCount).toHaveBeenCalledTimes(1));
    expect(exportCoordinator.withMutation).not.toHaveBeenCalled();

    releasePlayerCheck?.(0);
    await waiting;

    expect(exportCoordinator.withMutation).toHaveBeenCalledTimes(1);
    expect(serversRepository.recordScheduledRun).toHaveBeenCalledWith(server.id, schedule.id, expect.objectContaining({ status: "success" }));
  });

  it("persists a resumable checkpoint only while waiting for the server to empty", async () => {
    await executeMatchedSchedule(server, { ...schedule, onlyWhenNoPlayers: true, waitForPlayersToLeave: true });

    expect(operationsRepository.create).toHaveBeenCalledWith(expect.objectContaining({
      result: expect.objectContaining({
        kind: "schedule.wait-for-empty",
        version: 1,
        phase: "waiting",
        runId: expect.any(String),
        schedule: expect.objectContaining({ id: schedule.id, waitForPlayersToLeave: true })
      })
    }));
    expect(operationsRepository.update).toHaveBeenCalledWith("operation-1", expect.objectContaining({
      result: expect.objectContaining({ kind: "schedule.wait-for-empty", phase: "executing" })
    }));
  });

  it("restores a waiting execution and its duplicate guard after restart", async () => {
    const persistedSchedule = {
      ...schedule,
      steps: [{ type: "command" as const, command: "save-all", delaySeconds: 0 }],
      onlyWhenNoPlayers: true,
      waitForPlayersToLeave: true
    };
    const waitingOperation = {
      id: "operation-resume",
      type: "schedule.run",
      status: "running",
      serverId: server.id,
      nodeId: server.nodeId,
      progress: 10,
      createdAt: "2026-07-01T04:00:00.000Z",
      result: {
        kind: "schedule.wait-for-empty",
        version: 1,
        phase: "waiting",
        runId: "run-resume",
        startedAt: "2026-07-01T04:00:00.000Z",
        schedule: persistedSchedule
      }
    } as OperationRecord;
    operationsRepository.find.mockReturnValue(waitingOperation);
    serversRepository.find.mockReturnValue({
      ...server,
      schedules: [persistedSchedule]
    });

    const recoverable = resumableScheduleWaitOperations([waitingOperation]);
    expect(resumeWaitingScheduleExecutions(recoverable)).toBe(1);
    expect(runningSchedules.has(`${server.id}:${schedule.id}`)).toBe(true);
    expect(startScheduleExecution(server, schedule)).toBeUndefined();
    await vi.waitFor(() => expect(runningSchedules.size).toBe(0));

    expect(operationsRepository.create).not.toHaveBeenCalled();
    expect(operationsRepository.start).toHaveBeenCalledWith(waitingOperation.id, expect.objectContaining({
      task: `Resuming schedule ${schedule.name}`
    }));
    expect(serversRepository.recordScheduledRun).toHaveBeenCalledWith(server.id, schedule.id, expect.objectContaining({
      id: "run-resume",
      ranAt: "2026-07-01T04:00:00.000Z",
      status: "success"
    }));
  });

  it("updates the visible wait state as players leave", async () => {
    freshOnlineCount
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(0);
    const active = {
      id: "run-waiting",
      serverId: server.id,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      status: "running" as const,
      startedAt: new Date().toISOString(),
      stepCount: 0,
      cancellable: true,
      message: "Starting",
      operationId: "operation-waiting",
      controller: new AbortController()
    };

    await expect(waitUntilServerIsEmpty(server, { ...schedule, onlyWhenNoPlayers: true, waitForPlayersToLeave: true }, active, 0)).resolves.toBe("empty");

    expect(freshOnlineCount).toHaveBeenCalledTimes(3);
    expect(operationsRepository.update).toHaveBeenCalledWith(active.operationId, expect.objectContaining({ task: "Waiting for 3 players to leave" }));
    expect(operationsRepository.update).toHaveBeenCalledWith(active.operationId, expect.objectContaining({ task: "Waiting for 1 player to leave" }));
    expect(active.message).toBe("Server is empty; preparing schedule");
  });

  it("keeps waiting while server status is temporarily unavailable after restart", async () => {
    serverStatus
      .mockRejectedValueOnce(new Error("Remote node is reconnecting"))
      .mockResolvedValueOnce({ docker: { running: true } });
    const active = {
      id: "run-reconnecting",
      serverId: server.id,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      status: "running" as const,
      startedAt: new Date().toISOString(),
      stepCount: 0,
      cancellable: true,
      message: "Resuming after panel restart",
      operationId: "operation-reconnecting",
      controller: new AbortController()
    };

    await expect(waitUntilServerIsEmpty(
      server,
      { ...schedule, onlyWhenNoPlayers: true, waitForPlayersToLeave: true },
      active,
      0
    )).resolves.toBe("empty");

    expect(serverStatus).toHaveBeenCalledTimes(2);
    expect(operationsRepository.update).toHaveBeenCalledWith(active.operationId, expect.objectContaining({
      task: "Waiting for server status"
    }));
  });

  // The tick used to refuse to start at all while an export held the server, and because cron
  // matching is per wall-clock minute and never retroactive, the occurrence was spent with no run,
  // no status, and nothing for the operator to read afterwards.
  it("records an export collision as a skipped run instead of losing the occurrence", async () => {
    exportCoordinator.activeOperationId.mockReturnValue("export-1");

    await executeMatchedSchedule(server, schedule);

    expect(serversRepository.recordScheduledRun).toHaveBeenCalledWith(server.id, schedule.id, expect.objectContaining({
      status: "skipped",
      message: "Skipped because a server export was running"
    }));
    expect(exportCoordinator.withMutation).not.toHaveBeenCalled();
  });

  it("lets a waiting run queue behind the export rather than skipping it", async () => {
    // Reports the export holding the server for the first checks, then releasing it.
    exportCoordinator.activeOperationId
      .mockReturnValueOnce("export-1")
      .mockReturnValueOnce("export-1")
      .mockReturnValue(undefined);

    await executeMatchedSchedule(server, { ...schedule, onlyWhenNoPlayers: true, waitForPlayersToLeave: true });

    // The wait policy already accepts an unbounded delay, so it reaches the mutation wait instead.
    expect(serversRepository.recordScheduledRun).toHaveBeenCalledWith(server.id, schedule.id, expect.objectContaining({ status: "success" }));
    expect(exportCoordinator.withMutation).toHaveBeenCalledTimes(1);
  });

  it("keeps the manual run refusal while relaxing it for the scheduler", async () => {
    exportCoordinator.activeOperationId.mockReturnValue("export-1");
    exportCoordinator.assertMutationAllowed.mockImplementationOnce(() => {
      throw new Error("An export is in progress");
    });

    expect(() => startScheduleExecution(server, schedule)).toThrow("An export is in progress");
    expect(serversRepository.recordScheduledRun).not.toHaveBeenCalled();

    expect(startScheduleExecution(server, schedule, { requireAvailability: false })).toBeDefined();
    await vi.waitFor(() => expect(runningSchedules.size).toBe(0));

    expect(exportCoordinator.assertMutationAllowed).toHaveBeenCalledTimes(1);
    expect(serversRepository.recordScheduledRun).toHaveBeenCalledWith(server.id, schedule.id, expect.objectContaining({ status: "skipped" }));
  });

  it("cancels every run of a schedule at once, or none when one cannot be stopped", () => {
    const active = (id: string, cancellable: boolean) => ({
      id,
      serverId: server.id,
      scheduleId: schedule.id,
      scheduleName: schedule.name,
      status: "running" as const,
      startedAt: new Date().toISOString(),
      stepCount: 1,
      cancellable,
      operationId: `operation-${id}`,
      controller: new AbortController()
    });

    activeScheduleExecutions.set("run-a", active("run-a", true));
    activeScheduleExecutions.set("run-b", active("run-b", false));
    expect(cancelActiveScheduleRunsForSchedule(server.id, schedule.id)).toBe(false);
    // Refusing has to leave the cancellable run alone, or the delete is half applied.
    expect(activeScheduleExecutions.get("run-a")?.controller.signal.aborted).toBe(false);

    activeScheduleExecutions.delete("run-b");
    expect(cancelActiveScheduleRunsForSchedule(server.id, schedule.id)).toBe(true);
    expect(activeScheduleExecutions.get("run-a")?.controller.signal.aborted).toBe(true);

    // A schedule with nothing running is deletable.
    expect(cancelActiveScheduleRunsForSchedule(server.id, "schedule-none")).toBe(true);
  });

  // A schedule whose only action is Start exists precisely for a stopped server, so the guard that
  // skips a run against one has to let it through.
  it("runs a start-only schedule against a stopped server, and skips every other kind", () => {
    const stepsFor = (steps: ScheduledExecution["steps"]) => ({ steps });

    expect(scheduleRequiresRunningServer(stepsFor([{ type: "action", procedure: "start", delaySeconds: 0 }]))).toBe(false);
    expect(scheduleRequiresRunningServer(stepsFor([{ type: "action", procedure: "stop", delaySeconds: 0 }]))).toBe(true);
    expect(scheduleRequiresRunningServer(stepsFor([{ type: "action", procedure: "restart", delaySeconds: 0 }]))).toBe(true);
    // A command cannot reach a stopped server even when a Start follows it.
    expect(scheduleRequiresRunningServer(stepsFor([
      { type: "command", command: "save-all", delaySeconds: 0 },
      { type: "action", procedure: "start", delaySeconds: 0 }
    ]))).toBe(true);
  });

  it("does not stack another occurrence while one is waiting", async () => {
    freshOnlineCount.mockImplementationOnce(async () => {
      const active = [...activeScheduleExecutions.values()][0];
      active.controller.abort();
      return 2;
    });
    const waitingSchedule = { ...schedule, onlyWhenNoPlayers: true, waitForPlayersToLeave: true };

    expect(startScheduleExecution(server, waitingSchedule)).toBeDefined();
    expect(startScheduleExecution(server, waitingSchedule)).toBeUndefined();
    await vi.waitFor(() => expect(runningSchedules.size).toBe(0));

    expect(serversRepository.recordScheduledRun).toHaveBeenCalledTimes(1);
    expect(serversRepository.recordScheduledRun).toHaveBeenCalledWith(server.id, schedule.id, expect.objectContaining({ status: "cancelled" }));
  });
});
