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

vi.mock("../appServices.js", () => ({
  services: { operationsRepository, serversRepository },
  runtimeForServer: () => ({ serverStatus, serverLogs: async () => ({ text: "" }) })
}));

const { executeMatchedSchedule } = await import("./engine.js");
const { activeScheduleExecutions } = await import("./activeRuns.js");

const server = { id: "server-1", nodeId: "local", displayName: "Survival" } as ManagedServer;
const schedule: ScheduledExecution = {
  id: "schedule-1",
  name: "Nightly restart",
  cron: "0 4 * * *",
  steps: [],
  onlyWhenNoPlayers: false,
  enabled: true,
  createdAt: "2026-07-01T00:00:00.000Z",
  updatedAt: "2026-07-01T00:00:00.000Z"
};

describe("scheduled run bookkeeping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    activeScheduleExecutions.clear();
  });

  it("clears the active run and resolves the operation after a successful run", async () => {
    await executeMatchedSchedule(server, schedule);

    expect(activeScheduleExecutions.size).toBe(0);
    expect(serversRepository.recordScheduledRun).toHaveBeenCalledTimes(1);
    expect(operationsRepository.succeed).toHaveBeenCalledTimes(1);
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
});
