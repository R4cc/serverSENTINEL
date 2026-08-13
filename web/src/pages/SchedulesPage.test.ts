import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ScheduledActiveRun, ScheduledExecution } from "../types";
import {
  activeRunStatus,
  lastRunRelativeTime,
  nextRunRelativeTime,
  SchedulePage,
  SchedulePlayerPolicyOptions,
  ScheduleRunDetailsDialog,
  ScheduleRunHistoryDialog,
  resolveScheduleNavigationTarget,
  reorderScheduleSteps,
  scheduleDescription,
  scheduleStepMoveBlocked,
  scheduleStepTypeAvailability,
  scheduleRunFeedKey,
  scheduleRunItems
} from "./SchedulesPage";

function schedule(steps: ScheduledExecution["steps"]): ScheduledExecution {
  return {
    id: "schedule-1",
    name: "Nightly maintenance",
    cron: "0 4 * * *",
    steps,
    onlyWhenNoPlayers: false,
    waitForPlayersToLeave: false,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };
}

function renderSchedulePage(schedules: ScheduledExecution[], overrides: Partial<ComponentProps<typeof SchedulePage>> = {}) {
  const props: ComponentProps<typeof SchedulePage> = {
    schedules,
    relativeTimestamps: true,
    formatDate: (timestamp) => new Date(timestamp).toISOString(),
    scheduleTimeZone: "UTC",
    onCreate: () => undefined,
    onToggle: () => undefined,
    onUpdate: () => true,
    onDelete: () => undefined,
    onRunNow: () => true,
    onCancelRun: () => true,
    disabled: false,
    ...overrides
  };
  return renderToStaticMarkup(createElement(SchedulePage, props));
}

describe("schedule step summaries", () => {
  it("reorders steps by stable client id without mutating the source", () => {
    const steps = [{ id: "one" }, { id: "two" }, { id: "three" }];

    expect(reorderScheduleSteps(steps, "three", "one").map((step) => step.id)).toEqual(["three", "one", "two"]);
    expect(reorderScheduleSteps(steps, "one", "three").map((step) => step.id)).toEqual(["two", "three", "one"]);
    expect(steps.map((step) => step.id)).toEqual(["one", "two", "three"]);
  });

  // Both Restart rules were enforced only at submit, so the Type control offered Action on step 1
  // of 3 and then the save was rejected.
  it("offers Restart only where one could legally go", () => {
    const steps = [
      { id: "one", type: "command" as const },
      { id: "two", type: "command" as const }
    ];

    expect(scheduleStepTypeAvailability(steps, "one").canBecomeRestart).toBe(false);
    expect(scheduleStepTypeAvailability(steps, "one").reason).toBe("Restart has to be the last step.");
    expect(scheduleStepTypeAvailability(steps, "two").canBecomeRestart).toBe(true);

    const withRestart = [steps[0], { id: "two", type: "action" as const }];
    expect(scheduleStepTypeAvailability(withRestart, "two").canBecomeRestart).toBe(true);
    // A second Restart is not available anywhere, including the step that already is one.
    expect(scheduleStepTypeAvailability([...withRestart, { id: "three", type: "command" as const }], "three").canBecomeRestart).toBe(false);
  });

  it("refuses a reorder that would leave Restart anywhere but last", () => {
    const steps = [
      { type: "command" as const },
      { type: "command" as const },
      { type: "action" as const }
    ];

    expect(scheduleStepMoveBlocked(steps, 2, 1)).toBe(true);
    expect(scheduleStepMoveBlocked(steps, 0, 2)).toBe(true);
    expect(scheduleStepMoveBlocked(steps, 0, 1)).toBe(false);
    // Without a Restart step every move is fine.
    expect(scheduleStepMoveBlocked([{ type: "command" as const }, { type: "command" as const }], 1, 0)).toBe(false);
  });

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

describe("overview schedule navigation", () => {
  const activeRun: ScheduledActiveRun = {
    id: "run-active",
    scheduleId: "schedule-1",
    scheduleName: "Nightly maintenance",
    status: "running",
    startedAt: "2026-07-14T11:55:00.000Z",
    stepCount: 1,
    cancellable: true
  };
  const value: ScheduledExecution = {
    ...schedule([{ type: "command", command: "save-all", delaySeconds: 0 }]),
    activeRuns: [activeRun],
    recentRuns: [{ id: "run-completed", scheduleId: "schedule-1", scheduleName: "Nightly maintenance", status: "success", ranAt: "2026-07-14T06:40:00.000Z" }]
  };

  it("resolves schedule, active-run, and completed-run targets without crossing run kinds", () => {
    expect(resolveScheduleNavigationTarget([value], { kind: "schedule", scheduleId: "schedule-1" })).toMatchObject({ kind: "schedule", schedule: { id: "schedule-1" } });
    expect(resolveScheduleNavigationTarget([value], { kind: "active-run", scheduleId: "schedule-1", runId: "run-active" })).toMatchObject({ kind: "active-run", run: { id: "run-active" } });
    expect(resolveScheduleNavigationTarget([value], { kind: "completed-run", scheduleId: "schedule-1", runId: "run-completed" })).toMatchObject({ kind: "completed-run", run: { id: "run-completed" } });
    expect(resolveScheduleNavigationTarget([value], { kind: "completed-run", scheduleId: "schedule-1", runId: "run-active" })).toBeUndefined();
  });

  it("includes the configured online-player behavior in schedule summaries", () => {
    const base = schedule([{ type: "command", command: "save-all", delaySeconds: 0 }]);

    expect(scheduleDescription({ ...base, onlyWhenNoPlayers: true })).toBe("save-all · skips while players are online");
    expect(scheduleDescription({ ...base, onlyWhenNoPlayers: true, waitForPlayersToLeave: true })).toBe("save-all · waits until no players are online");
  });
});

describe("online-player schedule options", () => {
  it("explains all three outcomes and selects the waiting policy", () => {
    const value = {
      ...schedule([{ type: "command", command: "save-all", delaySeconds: 0 }]),
      onlyWhenNoPlayers: true,
      waitForPlayersToLeave: true
    };
    const html = renderToStaticMarkup(createElement(SchedulePlayerPolicyOptions, { schedule: value }));

    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("Run anyway");
    expect(html).toContain("Skip this run");
    expect(html).toContain("Wait until empty");
    expect(html).toContain("runs never stack up");
    expect(html).toMatch(/<input(?=[^>]+value="wait")(?=[^>]+checked)[^>]*>/);
    expect(html.match(/checked=""/g)).toHaveLength(1);
  });
});

describe("schedule workspace rendering", () => {
  it("omits summary metrics and keeps disabled and active states accessible", () => {
    const activeRun: ScheduledActiveRun = {
      id: "run-active",
      scheduleId: "schedule-1",
      scheduleName: "Nightly maintenance",
      status: "running",
      startedAt: "2026-07-14T11:55:00.000Z",
      stepCount: 2,
      currentStepIndex: 0,
      currentStep: "save-all",
      cancellable: true
    };
    const enabled = { ...schedule([{ type: "command", command: "save-all", delaySeconds: 0 }]), activeRuns: [activeRun] };
    const disabled = {
      ...schedule([{ type: "command", command: "say hello", delaySeconds: 0 }]),
      id: "schedule-2",
      name: "Disabled maintenance",
      enabled: false
    };
    const html = renderSchedulePage([enabled, disabled]);

    expect(html).not.toContain('aria-label="Schedules status summary"');
    expect(html).not.toContain("Total schedules");
    expect(html).not.toContain("Active runs");
    expect(html).toContain("scheduleTableRow disabled");
    expect(html).toContain('aria-label="Enable Disabled maintenance"');
    expect(html).toContain('aria-label="Cancel Nightly maintenance"');
    expect(html).toContain('title="Nightly maintenance"');
    expect(html).toContain('title="save-all"');
  });

  it("renders cohesive empty states without summary metrics", () => {
    const html = renderSchedulePage([]);

    expect(html).not.toContain('aria-label="Schedules status summary"');
    expect(html).not.toContain("Total schedules");
    expect(html).not.toContain("Active runs");
    expect(html).toContain("No schedules added");
    expect(html).toContain("No runs yet");
  });

  // Skipping is the expected outcome of two of the three player policies, so the last-run mark has
  // to separate it from a failure. It shipped once as the same red cross a thrown run gets.
  it("gives a skipped last run its own mark instead of the failure one", () => {
    const lastRun = { lastRunAt: "2026-07-14T04:00:00.000Z" };
    const skipped = renderSchedulePage([{ ...schedule([{ type: "command", command: "save-all", delaySeconds: 0 }]), ...lastRun, lastStatus: "skipped" }]);
    const failed = renderSchedulePage([{ ...schedule([{ type: "command", command: "save-all", delaySeconds: 0 }]), ...lastRun, lastStatus: "failed" }]);

    expect(skipped).toContain('class="scheduleStatusIcon skipped"');
    expect(skipped).toContain('aria-label="Skipped"');
    expect(skipped).not.toContain("scheduleStatusIcon failed");
    expect(failed).toContain('class="scheduleStatusIcon failed"');
    expect(failed).toContain('aria-label="Failed"');
  });

  // The feed resets its scroll position when this key changes, and the page is handed a brand new
  // schedules array every time it polls. Keying on anything the poll rebuilds pulled the run the
  // reader was looking at out from under them every 15 seconds.
  it("identifies the runs feed by its contents, not by the array holding them", () => {
    const run = { id: "run-1", scheduleId: "schedule-1", scheduleName: "Nightly maintenance", status: "success", ranAt: "2026-07-14T04:00:00.000Z" };
    const polled = () => [{ ...schedule([{ type: "command", command: "save-all", delaySeconds: 0 }]), recentRuns: [{ ...run }] }];

    const first = polled();
    const second = polled();
    expect(second).not.toBe(first);
    expect(scheduleRunFeedKey(scheduleRunItems(second))).toBe(scheduleRunFeedKey(scheduleRunItems(first)));

    const advanced = polled();
    advanced[0].recentRuns = [{ ...run, id: "run-2", ranAt: "2026-07-15T04:00:00.000Z" }];
    expect(scheduleRunFeedKey(scheduleRunItems(advanced))).not.toBe(scheduleRunFeedKey(scheduleRunItems(first)));
  });

  it("describes the cron column with the same describer the editor uses", () => {
    const weekdays = { ...schedule([{ type: "command", command: "save-all", delaySeconds: 0 }]), cron: "0 4 * * 1-5" };

    const html = renderSchedulePage([weekdays]);

    expect(html).toContain("Every weekday at 04:00");
    expect(html).not.toContain("Weekly on 1-5");
  });
});

describe("schedule run history", () => {
  // The panel retains 25 runs per schedule; the feed beside the table mixes every schedule together
  // and stops at eight, so most of that history had nowhere to be read.
  it("lists every retained run for one schedule, newest first", () => {
    const runs = [
      { id: "run-old", scheduleId: "schedule-1", scheduleName: "Nightly maintenance", status: "failed", message: "Command failed", ranAt: "2026-07-10T04:00:00.000Z" },
      { id: "run-new", scheduleId: "schedule-1", scheduleName: "Nightly maintenance", status: "skipped", message: "Skipped because 3 players are online", ranAt: "2026-07-14T04:00:00.000Z" }
    ];

    const html = renderToStaticMarkup(createElement(ScheduleRunHistoryDialog, {
      schedule: { ...schedule([{ type: "command", command: "save-all", delaySeconds: 0 }]), recentRuns: runs },
      formatDate: (value: string | number | Date) => new Date(value).toISOString(),
      relativeTimestamps: false,
      relativeNow: Date.parse("2026-07-14T12:00:00.000Z"),
      onSelectRun: () => undefined,
      onClose: () => undefined
    }));

    expect(html).toContain("2 recorded runs");
    expect(html).toContain("Skipped because 3 players are online");
    expect(html).toContain("Command failed");
    expect(html.indexOf("run at 2026-07-14")).toBeLessThan(html.indexOf("run at 2026-07-10"));
  });

  it("says so when a schedule has never run", () => {
    const html = renderToStaticMarkup(createElement(ScheduleRunHistoryDialog, {
      schedule: schedule([{ type: "command", command: "save-all", delaySeconds: 0 }]),
      formatDate: (value: string | number | Date) => new Date(value).toISOString(),
      relativeNow: Date.now(),
      onSelectRun: () => undefined,
      onClose: () => undefined
    }));

    expect(html).toContain("No runs recorded");
    expect(html).toContain("0 recorded runs");
  });
});

describe("scheduled run details", () => {
  it("renders commands with expandable logs and actions without log sections", () => {
    const html = renderToStaticMarkup(createElement(ScheduleRunDetailsDialog, {
      run: {
        id: "run-1",
        scheduleId: "schedule-1",
        scheduleName: "Nightly maintenance",
        status: "success",
        message: "Completed 2 steps",
        ranAt: "2026-07-14T06:40:00.000Z",
        details: {
          stepCount: 2,
          completedStepCount: 2,
          steps: [{
            stepIndex: 0,
            type: "command",
            command: "save-all",
            delaySeconds: 0,
            status: "success",
            startedAt: "2026-07-14T06:40:00.000Z",
            completedAt: "2026-07-14T06:40:01.000Z",
            logs: ["[Server thread/INFO]: Saved the game"],
            logCaptureStatus: "captured"
          }, {
            stepIndex: 1,
            type: "action",
            procedure: "restart",
            delaySeconds: 300,
            status: "success",
            startedAt: "2026-07-14T06:45:00.000Z",
            completedAt: "2026-07-14T06:45:10.000Z"
          }]
        }
      },
      formatDate: (timestamp) => new Date(timestamp).toISOString(),
      onClose: () => undefined
    }));

    expect(html).toContain("Executed steps");
    expect(html).toContain("save-all");
    expect(html).toContain("Saved the game");
    expect(html).toContain("Restart action");
    expect(html.match(/<details/g)).toHaveLength(1);
  });

  it("explains when an older run has no detailed step snapshot", () => {
    const html = renderToStaticMarkup(createElement(ScheduleRunDetailsDialog, {
      run: {
        id: "legacy-run",
        scheduleId: "schedule-1",
        scheduleName: "Nightly maintenance",
        status: "success",
        ranAt: "2026-07-14T06:40:00.000Z"
      },
      formatDate: (timestamp) => new Date(timestamp).toISOString(),
      onClose: () => undefined
    }));

    expect(html).toContain("Step details unavailable");
    expect(html).toContain("before detailed command history was enabled");
  });
});

describe("schedule table relative times", () => {
  const now = Date.parse("2026-07-14T12:00:00.000Z");

  it("keeps past runs readable and rounded", () => {
    expect(lastRunRelativeTime("2026-07-14T06:40:00.000Z", now)).toBe("5 hours ago");
    expect(lastRunRelativeTime("2026-07-14T11:59:40.000Z", now)).toBe("Just now");
    expect(lastRunRelativeTime("2026-07-12T12:00:00.000Z", now)).toBe("2 days ago");
  });

  it("keeps upcoming runs precise to the minute", () => {
    expect(nextRunRelativeTime("2026-07-14T22:31:00.000Z", now)).toBe("in 10h 31m");
    expect(nextRunRelativeTime("2026-07-16T13:02:00.000Z", now)).toBe("in 2d 1h 2m");
    expect(nextRunRelativeTime("2026-07-14T12:00:00.000Z", now)).toBe("Due now");
  });

  it("handles invalid timestamps", () => {
    expect(lastRunRelativeTime("not-a-date", now)).toBe("Unknown");
    expect(nextRunRelativeTime("not-a-date", now)).toBe("Unknown");
  });
});

describe("schedule timestamp preference", () => {
  it("renders full dates for the table and run history when relative timestamps are disabled", () => {
    const value: ScheduledExecution = {
      ...schedule([{ type: "command", command: "save-all", delaySeconds: 0 }]),
      lastRunAt: "2026-07-14T06:40:00.000Z",
      nextRunAt: "2026-07-14T22:31:00.000Z",
      lastStatus: "success",
      recentRuns: [{
        id: "run-1",
        scheduleId: "schedule-1",
        scheduleName: "Nightly maintenance",
        status: "success",
        ranAt: "2026-07-14T06:40:00.000Z"
      }]
    };
    const html = renderToStaticMarkup(createElement(SchedulePage, {
      schedules: [value],
      relativeTimestamps: false,
      formatDate: (timestamp) => `FULL ${new Date(timestamp).toISOString()}`,
      scheduleTimeZone: "UTC",
      onCreate: () => undefined,
      onToggle: () => undefined,
      onUpdate: () => true,
      onDelete: () => undefined,
      onRunNow: () => true,
      onCancelRun: () => true,
      disabled: false
    }));

    expect(html).toContain("FULL 2026-07-14T06:40:00.000Z");
    expect(html).toContain("FULL 2026-07-14T22:31:00.000Z");
    expect(html).toContain('role="img" aria-label="Succeeded"');
    expect(html).not.toContain("hours ago");
    expect(html).not.toContain("in 10h");
  });
});
