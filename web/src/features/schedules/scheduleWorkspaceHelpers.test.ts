import { describe, expect, it } from "vitest";
import type { ScheduleStep, ScheduledExecution } from "../../types";
import {
  createDemoSchedule,
  scheduleDisabledReason,
  scheduleUpdateLabel,
  scheduleValidationMessage,
  type SchedulePatch
} from "./scheduleWorkspaceHelpers";

const commandStep: ScheduleStep = { type: "command", command: "say hello", delaySeconds: 5 };

function patch(overrides: Partial<SchedulePatch> = {}): SchedulePatch {
  return {
    name: "Backup",
    cron: "0 3 * * *",
    steps: [commandStep],
    onlyWhenNoPlayers: true,
    enabled: true,
    ...overrides
  };
}

describe("schedule workspace helpers", () => {
  it("returns the first schedule validation error", () => {
    expect(scheduleValidationMessage(patch({ name: "" }))).toBe("Schedule name is required.");
    expect(scheduleValidationMessage(patch({ cron: "invalid" }))).toBeTruthy();
    expect(scheduleValidationMessage(patch({ steps: [{ ...commandStep, command: "" }] }))).toBeTruthy();
    expect(scheduleValidationMessage(patch())).toBe("");
  });

  it("preserves legacy command fields only for command-only demo schedules", () => {
    const created = createDemoSchedule(patch(), "schedule-1", "2026-07-15T10:00:00.000Z");
    expect(created).toMatchObject({
      id: "schedule-1",
      commands: ["say hello"],
      commandDelaysSeconds: [5],
      createdAt: "2026-07-15T10:00:00.000Z",
      updatedAt: "2026-07-15T10:00:00.000Z"
    });

    const withRestart = createDemoSchedule(patch({ steps: [{ type: "action", procedure: "restart", delaySeconds: 0 }] }), "schedule-2", "now");
    expect(withRestart).not.toHaveProperty("commands");
    expect(withRestart).not.toHaveProperty("commandDelaysSeconds");
  });

  it("labels toggles separately from general updates", () => {
    expect(scheduleUpdateLabel({ enabled: true })).toBe("Schedule enabled");
    expect(scheduleUpdateLabel({ enabled: false })).toBe("Schedule disabled");
    expect(scheduleUpdateLabel({ enabled: true, name: "Nightly" } as Partial<ScheduledExecution>)).toBe("Schedule updated");
  });

  it("prioritizes the existing schedule lock reasons", () => {
    expect(scheduleDisabledReason({ busy: true, isProvisioning: true, canManage: false, runtimeLocked: true, runtimeLockedReason: "Offline" })).toBe("Schedule changes are still saving.");
    expect(scheduleDisabledReason({ busy: false, isProvisioning: false, canManage: true, runtimeLocked: true, runtimeLockedReason: "Offline" })).toBe("Offline");
  });
});
