import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ScheduleRunDetailsDialog, scheduleRunLogsPending } from "./SchedulesPage";
import type { ScheduledRun, ScheduledRunStepDetails } from "../types";

function step(overrides: Partial<ScheduledRunStepDetails> = {}): ScheduledRunStepDetails {
  return {
    stepIndex: 0,
    type: "command",
    command: "save-all",
    delaySeconds: 0,
    status: "success",
    startedAt: "2026-01-01T04:00:00.000Z",
    logCaptureStatus: "captured",
    ...overrides
  };
}

function run(steps: ScheduledRunStepDetails[]): ScheduledRun {
  return {
    id: "run-1",
    scheduleId: "schedule-1",
    scheduleName: "Nightly restart",
    status: "success",
    ranAt: "2026-01-01T04:00:00.000Z",
    details: { stepCount: steps.length, completedStepCount: steps.length, steps }
  };
}

const formatDate = (value: string | number | Date) => String(value);

describe("schedule run log loading", () => {
  it("treats a captured step without logs as pending", () => {
    expect(scheduleRunLogsPending(run([step()]))).toBe(true);
  });

  it("does not request logs for steps that captured nothing", () => {
    expect(scheduleRunLogsPending(run([step({ logCaptureStatus: "empty" })]))).toBe(false);
    expect(scheduleRunLogsPending(run([step({ logCaptureStatus: "unavailable" })]))).toBe(false);
    expect(scheduleRunLogsPending(run([step({ type: "action", procedure: "restart", command: undefined })]))).toBe(false);
  });

  it("does not request logs that already arrived", () => {
    expect(scheduleRunLogsPending(run([step({ logs: ["saved"] })]))).toBe(false);
  });

  it("reads as loading on the first paint so it never flashes as unavailable", () => {
    const html = renderToStaticMarkup(
      <ScheduleRunDetailsDialog run={run([step()])} formatDate={formatDate} onLoadRunLogs={vi.fn()} onClose={vi.fn()} />
    );

    expect(html).toContain("Loading console output");
    expect(html).not.toContain("Console output is unavailable");
  });

  it("renders logs that came with the run without waiting on a request", () => {
    const html = renderToStaticMarkup(
      <ScheduleRunDetailsDialog run={run([step({ logs: ["[12:00:00] Saved the game"] })])} formatDate={formatDate} onLoadRunLogs={vi.fn()} onClose={vi.fn()} />
    );

    expect(html).toContain("Saved the game");
    expect(html).toContain("1 entry");
    expect(html).not.toContain("Loading console output");
  });

  it("keeps the recorded outcome for a step that captured nothing", () => {
    const html = renderToStaticMarkup(
      <ScheduleRunDetailsDialog run={run([step({ logCaptureStatus: "empty" })])} formatDate={formatDate} onLoadRunLogs={vi.fn()} onClose={vi.fn()} />
    );

    expect(html).toContain("No follow-up log entries were captured.");
    expect(html).not.toContain("Loading console output");
  });
});
