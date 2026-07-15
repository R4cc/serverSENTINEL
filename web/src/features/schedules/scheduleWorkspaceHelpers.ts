import type { ScheduledExecution } from "../../types";
import { validateCommandList, validateCronExpression } from "../../utils/validation";

export type SchedulePatch = Pick<ScheduledExecution, "name" | "cron" | "steps" | "onlyWhenNoPlayers" | "enabled">;

export function scheduleValidationMessage(patch: SchedulePatch) {
  if (!patch.name) return "Schedule name is required.";
  const cronError = validateCronExpression(patch.cron);
  if (cronError) return cronError;
  const commands = patch.steps.filter((step) => step.type === "command").map((step) => step.command);
  return commands.length ? validateCommandList(commands) ?? "" : "";
}

export function scheduleUpdateLabel(patch: Partial<ScheduledExecution>) {
  if (patch.enabled !== undefined && Object.keys(patch).length === 1) {
    return patch.enabled ? "Schedule enabled" : "Schedule disabled";
  }
  return "Schedule updated";
}

export function createDemoSchedule(patch: SchedulePatch, id: string, now: string): ScheduledExecution {
  return {
    id,
    name: patch.name,
    cron: patch.cron,
    steps: patch.steps,
    onlyWhenNoPlayers: patch.onlyWhenNoPlayers,
    enabled: patch.enabled,
    createdAt: now,
    updatedAt: now,
    lastMessage: "Not run in demo session"
  };
}

export function scheduleDisabledReason({
  busy,
  isProvisioning,
  canManage,
  runtimeLocked,
  runtimeLockedReason
}: {
  busy: boolean;
  isProvisioning: boolean;
  canManage: boolean;
  runtimeLocked: boolean;
  runtimeLockedReason: string;
}) {
  if (busy) return "Schedule changes are still saving.";
  if (isProvisioning) return "Server setup is still running.";
  if (!canManage) return "Manage schedules permission is required.";
  if (runtimeLocked) return runtimeLockedReason || "Server runtime is unavailable.";
  return "";
}
