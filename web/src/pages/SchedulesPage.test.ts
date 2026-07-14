import { describe, expect, it } from "vitest";
import type { ScheduledActiveRun, ScheduledExecution } from "../types";
import { activeRunStatus, scheduleDescription } from "./SchedulesPage";

function schedule(steps: ScheduledExecution["steps"]): ScheduledExecution {
  return {
    id: "schedule-1",
    name: "Nightly maintenance",
    cron: "0 4 * * *",
    steps,
    onlyWhenNoPlayers: false,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

describe("schedule step summaries", () => {
  it("describes mixed commands, restart actions, and delays", () => {
    expect(scheduleDescription(schedule([
      { type: "command", command: "say restarting", delaySeconds: 0 },
      { type: "action", procedure: "restart", delaySeconds: 300 }
    ]))).toBe("1 command, 1 Restart action, 1 delayed");
  });

  it("shows a single command verbatim", () => {
    expect(scheduleDescription(schedule([{ type: "command", command: "save-all", delaySeconds: 0 }]))).toBe("save-all");
  });
});

describe("active schedule status", () => {
  it("shows the lifecycle phase once Restart is non-cancellable", () => {
    const run: ScheduledActiveRun = {
      id: "run-1",
      scheduleId: "schedule-1",
      scheduleName: "Nightly maintenance",
      status: "running",
      startedAt: "2026-01-01T00:00:00.000Z",
      stepCount: 2,
      currentStepIndex: 1,
      currentStep: "Restart",
      cancellable: false,
      message: "Restarting server"
    };

    expect(activeRunStatus(run)).toBe("Restarting server");
  });
});
