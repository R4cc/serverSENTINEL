import { describe, expect, it } from "vitest";
import { findScheduledRun, publicSchedule, scheduledRunSummary } from "./store.js";
import type { ManagedServer, ScheduledExecution, ScheduledRun } from "../types.js";

const scheduleId = "22222222-2222-2222-2222-222222222222";

function run(id: string, logs?: string[]): ScheduledRun {
  return {
    id,
    scheduleId,
    scheduleName: "Nightly restart",
    status: "success",
    ranAt: "2026-01-01T04:00:00.000Z",
    details: {
      stepCount: 2,
      completedStepCount: 2,
      steps: [
        {
          stepIndex: 0,
          type: "command",
          command: "save-all",
          delaySeconds: 0,
          status: "success",
          startedAt: "2026-01-01T04:00:00.000Z",
          logs,
          logCaptureStatus: logs ? "captured" : "empty"
        },
        {
          stepIndex: 1,
          type: "action",
          procedure: "restart",
          delaySeconds: 30,
          status: "success",
          startedAt: "2026-01-01T04:00:30.000Z"
        }
      ]
    }
  };
}

function schedule(recentRuns: ScheduledRun[]): ScheduledExecution {
  return {
    id: scheduleId,
    name: "Nightly restart",
    cron: "0 4 * * *",
    steps: [{ type: "command", command: "save-all", delaySeconds: 0 }],
    onlyWhenNoPlayers: false,
    waitForPlayersToLeave: false,
    enabled: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    recentRuns
  };
}

describe("scheduled run projections", () => {
  it("drops captured console output but keeps every other step field", () => {
    const summary = scheduledRunSummary(run("run-1", ["saved", "done"]));
    const steps = summary.details?.steps ?? [];

    expect(steps[0]).toEqual({
      stepIndex: 0,
      type: "command",
      command: "save-all",
      delaySeconds: 0,
      status: "success",
      startedAt: "2026-01-01T04:00:00.000Z",
      logCaptureStatus: "captured"
    });
    expect(steps[0]).not.toHaveProperty("logs");
    // The status has to survive so the list can tell "nothing was captured" from "logs exist".
    expect(steps[1]).toEqual(run("run-1").details?.steps?.[1]);
  });

  it("leaves a run without recorded steps untouched", () => {
    const bare: ScheduledRun = { id: "run-2", scheduleId, scheduleName: "Nightly restart", status: "skipped", ranAt: "2026-01-01T04:00:00.000Z" };
    expect(scheduledRunSummary(bare)).toBe(bare);
  });

  it("trims every run in a projected schedule", () => {
    const projected = publicSchedule("server-1", schedule([run("run-1", ["a"]), run("run-2", ["b"])]));

    expect(projected.recentRuns).toHaveLength(2);
    for (const entry of projected.recentRuns ?? []) {
      for (const step of entry.details?.steps ?? []) expect(step.logs).toBeUndefined();
    }
  });

  it("finds a stored run with its console output intact", () => {
    const stored = run("run-1", ["saved"]);
    const server = { id: "server-1", schedules: [schedule([stored])] } as ManagedServer;

    expect(findScheduledRun(server, scheduleId, "run-1")?.details?.steps?.[0].logs).toEqual(["saved"]);
    expect(findScheduledRun(server, scheduleId, "missing")).toBeUndefined();
    expect(findScheduledRun(server, "other-schedule", "run-1")).toBeUndefined();
  });
});
