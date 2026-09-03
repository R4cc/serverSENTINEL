import { asObject } from "../storage/valueValidation.js";
import type { ScheduleProcedure, ScheduleStep } from "../types.js";

const scheduleProcedures: ScheduleProcedure[] = ["restart", "stop", "start"];

function sanitizeCommands(commands: unknown) {
  if (!Array.isArray(commands)) {
    throw new Error("At least one command is required");
  }
  const clean = commands
    .map((command) => typeof command === "string" ? command.trim().replace(/^\//, "") : "")
    .filter(Boolean);
  if (!clean.length) {
    throw new Error("At least one command is required");
  }
  if (clean.some((command) => /[\r\n]/.test(command))) {
    throw new Error("Scheduled commands must be one line each");
  }
  return clean;
}

const maximumCommandDelaySeconds = 604_800;

export function sanitizeScheduleSteps(steps: unknown): ScheduleStep[] {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("At least one schedule step is required");
  const normalized = steps.map((raw, index): ScheduleStep => {
    const step = asObject(raw, `steps[${index}]`);
    const delaySeconds = step.delaySeconds;
    if (!Number.isInteger(delaySeconds) || (delaySeconds as number) < 0 || (delaySeconds as number) > maximumCommandDelaySeconds) {
      throw new Error(`Step ${index + 1} delay must be a whole number of seconds between 0 and ${maximumCommandDelaySeconds}`);
    }
    if (step.type === "command") {
      const [command] = sanitizeCommands([step.command]);
      return { type: "command", command, delaySeconds: delaySeconds as number };
    }
    if (step.type === "action") {
      if (!scheduleProcedures.includes(step.procedure as ScheduleProcedure)) {
        throw new Error(`Unsupported schedule action procedure at step ${index + 1}`);
      }
      return { type: "action", procedure: step.procedure as ScheduleProcedure, delaySeconds: delaySeconds as number };
    }
    throw new Error(`Step ${index + 1} type must be command or action`);
  });
  for (const [index, step] of normalized.entries()) {
    if (step.type !== "action" || step.procedure !== "stop" || index === normalized.length - 1) continue;
    const next = normalized[index + 1];
    if (next.type !== "action" || next.procedure !== "start") {
      throw new Error(`Step ${index + 1} stops the server. A non-final Stop must be followed immediately by Start`);
    }
  }
  return normalized;
}

export class ScheduleCancellationError extends Error {
  constructor(message = "Schedule run cancelled by user") {
    super(message);
    this.name = "ScheduleCancellationError";
  }
}

export function throwIfScheduleCancelled(signal?: AbortSignal) {
  if (signal?.aborted) throw new ScheduleCancellationError();
}

export function waitForCommandDelay(seconds: number, signal?: AbortSignal) {
  throwIfScheduleCancelled(signal);
  if (seconds === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let timeout: NodeJS.Timeout;
    let abort = () => {};
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const finish = () => {
      cleanup();
      resolve();
    };
    abort = () => {
      clearTimeout(timeout);
      cleanup();
      reject(new ScheduleCancellationError());
    };
    timeout = setTimeout(finish, seconds * 1000);
    timeout.unref?.();
    signal?.addEventListener("abort", abort, { once: true });
  }).finally(() => {
    throwIfScheduleCancelled(signal);
  });
}
