import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ScheduledActiveRun, ScheduledExecution } from "../types";
import {
  activeRunStatus,
  lastRunRelativeTime,
  nextRunRelativeTime,
  SchedulePage,
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
    expect(html).not.toContain("hours ago");
    expect(html).not.toContain("in 10h");
  });
});
