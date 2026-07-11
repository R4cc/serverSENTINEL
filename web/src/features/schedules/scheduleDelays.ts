export type ScheduleDelayUnit = "seconds" | "minutes" | "hours";

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

export function scheduleDelayLabel(seconds: number) {
  const { value, unit } = scheduleDelayParts(seconds);
  const singular = value === 1 ? unit.slice(0, -1) : unit;
  return `${value} ${singular}`;
}
