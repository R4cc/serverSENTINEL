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
const { activeScheduleExecutions, runningSchedules } = await import("./activeRuns.js");

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
