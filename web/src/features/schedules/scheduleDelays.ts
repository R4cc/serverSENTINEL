type ScheduleDelayUnit = "seconds" | "minutes" | "hours";

const secondsPerUnit: Record<ScheduleDelayUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600
};

export function scheduleDelayToSeconds(value: number, unit: string) {
  const multiplier = secondsPerUnit[unit as ScheduleDelayUnit];
  return Number.isFinite(value) && multiplier ? value * multiplier : Number.NaN;
}

export function scheduleDelayParts(seconds: number): { value: number; unit: ScheduleDelayUnit } {
  if (seconds > 0 && seconds % 3600 === 0) return { value: seconds / 3600, unit: "hours" };
  if (seconds > 0 && seconds % 60 === 0) return { value: seconds / 60, unit: "minutes" };
  return { value: seconds, unit: "seconds" };
}

/**
 * How far each step sits from the scheduled start. The editor asks for the delay before a step,
 * which is relative to the step above it, but people build these thinking in absolute terms -- warn
 * at 04:00, warn again at 04:04, restart at 04:05 -- and had to add the delays up themselves.
 */
export function scheduleStepOffsets(delaysSeconds: number[]) {
  let elapsed = 0;
  return delaysSeconds.map((delay) => {
    elapsed += Number.isFinite(delay) && delay > 0 ? delay : 0;
    return elapsed;
  });
}

/**
 * The compact form that sits beside a step number. It shares a row with the step's controls, so it
 * has to stay short enough not to steal width from them.
 */
export function scheduleOffsetBadge(seconds: number) {
  return seconds <= 0 ? "start" : formatScheduleOffset(seconds);
}

export function formatScheduleOffset(seconds: number) {
  if (seconds <= 0) return "at the scheduled time";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  const parts = [
    hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "",
    remainder ? `${remainder}s` : ""
  ].filter(Boolean);
  return `+${parts.join(" ")}`;
}
