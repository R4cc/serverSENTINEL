import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ScheduledActiveRun, ScheduledExecution } from "../types";
import {
  activeRunStatus,
  lastRunRelativeTime,
  nextRunRelativeTime,
  SchedulePage,
  ScheduleRunDetailsDialog,
  reorderScheduleSteps,
  scheduleDescription
} from "./SchedulesPage";

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
  });

  it("renders cohesive empty states without summary metrics", () => {
    const html = renderSchedulePage([]);

    expect(html).not.toContain('aria-label="Schedules status summary"');
    expect(html).not.toContain("Total schedules");
    expect(html).not.toContain("Active runs");
    expect(html).toContain("No schedules added");
    expect(html).toContain("No runs yet");
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
