import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedServer, OperationRecord, ScheduledExecution } from "../types.js";

const operationsRepository = {
  create: vi.fn((input: Record<string, unknown>) => ({ id: "operation-1", ...input } as unknown as OperationRecord)),
  start: vi.fn(),
  update: vi.fn(),
  cancel: vi.fn(),
  fail: vi.fn(),
  succeed: vi.fn()
};
const serversRepository = { recordScheduledRun: vi.fn() };
const serverStatus = vi.fn(async () => ({ docker: { running: true } }));
const freshOnlineCount = vi.fn(async (): Promise<number | null> => 0);
const exportCoordinator = {
  activeOperationId: vi.fn((): string | undefined => undefined),
  assertMutationAllowed: vi.fn(),
  withMutation: vi.fn(async (_serverId: string, action: () => Promise<unknown>) => action())
};

vi.mock("../appServices.js", () => ({
  services: { operationsRepository, serversRepository, exportCoordinator, playerSnapshotCoordinator: { freshOnlineCount } },
  runtimeForServer: () => ({ serverStatus, serverLogs: async () => ({ text: "" }) })
}));

const { executeMatchedSchedule, scheduleFromBody, startScheduleExecution, waitUntilServerIsEmpty } = await import("./engine.js");
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
