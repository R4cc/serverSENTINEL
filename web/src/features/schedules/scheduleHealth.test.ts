import { describe, expect, it } from "vitest";
import type { ScheduledExecution, ScheduledRun } from "../../types";
import { scheduleHealth, schedulesNeedingAttention } from "./scheduleHealth";

function run(status: string, ranAt: string, message?: string): ScheduledRun {
  return { id: `run-${ranAt}`, scheduleId: "schedule-1", scheduleName: "Nightly maintenance", status, message, ranAt };
}

function schedule(recentRuns: ScheduledRun[], overrides: Partial<ScheduledExecution> = {}): ScheduledExecution {
  return {
    id: "schedule-1",
    name: "Nightly maintenance",
    cron: "0 4 * * *",
    steps: [{ type: "command", command: "save-all", delaySeconds: 0 }],
    onlyWhenNoPlayers: false,
    waitForPlayersToLeave: false,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    recentRuns,
    ...overrides
  };
}

describe("schedule health", () => {
  it("reports a run of failures", () => {
    const health = scheduleHealth(schedule([
      run("failed", "2026-07-14T04:00:00.000Z", "Command failed"),
      run("failed", "2026-07-13T04:00:00.000Z"),
      run("failed", "2026-07-12T04:00:00.000Z")
    ]));

    expect(health).toMatchObject({ tone: "failed", label: "Failed 3 runs in a row", detail: "Command failed" });
  });

  // A schedule skipping every night is not an error, and its last run does not read as one, which is
  // exactly why it can go unnoticed while doing nothing.
  it("reports a run of skips, which nothing else distinguishes from working", () => {
    const health = scheduleHealth(schedule([
      run("skipped", "2026-07-14T04:00:00.000Z", "Skipped because Minecraft server is stopped"),
      run("skipped", "2026-07-13T04:00:00.000Z"),
      run("skipped", "2026-07-12T04:00:00.000Z"),
      run("success", "2026-07-11T04:00:00.000Z")
    ]));

    expect(health).toMatchObject({ tone: "skipped", label: "Skipped 3 runs in a row" });
    expect(health?.detail).toContain("server is stopped");
  });

  it("stays quiet for a schedule that is working, or has barely run", () => {
    expect(scheduleHealth(schedule([
      run("success", "2026-07-14T04:00:00.000Z"),
      run("failed", "2026-07-13T04:00:00.000Z"),
      run("failed", "2026-07-12T04:00:00.000Z")
    ]))).toBeNull();
    // Two failures are noise; the streak has to reach three.
    expect(scheduleHealth(schedule([
      run("failed", "2026-07-14T04:00:00.000Z"),
      run("failed", "2026-07-13T04:00:00.000Z")
    ]))).toBeNull();
    expect(scheduleHealth(schedule([]))).toBeNull();
  });

  it("reads the runs newest first however they arrive", () => {
    const health = scheduleHealth(schedule([
      run("failed", "2026-07-12T04:00:00.000Z"),
      run("failed", "2026-07-14T04:00:00.000Z", "Newest"),
      run("failed", "2026-07-13T04:00:00.000Z")
    ]));

    expect(health?.detail).toBe("Newest");
  });

  it("ignores disabled schedules when collecting what needs attention", () => {
    const failing = [
      run("failed", "2026-07-14T04:00:00.000Z"),
      run("failed", "2026-07-13T04:00:00.000Z"),
      run("failed", "2026-07-12T04:00:00.000Z")
    ];

    expect(schedulesNeedingAttention([schedule(failing)])).toHaveLength(1);
    expect(schedulesNeedingAttention([schedule(failing, { enabled: false })])).toHaveLength(0);
  });
});
