import { describe, expect, it } from "vitest";
import { formatScheduleOffset, scheduleDelayParts, scheduleDelayToSeconds, scheduleOffsetBadge, scheduleStepOffsets } from "./scheduleDelays";

describe("schedule delay units", () => {
  it("converts supported units to seconds", () => {
    expect(scheduleDelayToSeconds(15, "seconds")).toBe(15);
    expect(scheduleDelayToSeconds(5, "minutes")).toBe(300);
    expect(scheduleDelayToSeconds(2, "hours")).toBe(7200);
  });

  it("chooses a concise editable unit without losing precision", () => {
    expect(scheduleDelayParts(7200)).toEqual({ value: 2, unit: "hours" });
    expect(scheduleDelayParts(300)).toEqual({ value: 5, unit: "minutes" });
    expect(scheduleDelayParts(75)).toEqual({ value: 75, unit: "seconds" });
  });

  // The field asks for the delay before a step, but a restart-with-warnings schedule is built
  // thinking in absolute offsets, and adding them up was left to the reader.
  it("accumulates per-step delays into offsets from the scheduled start", () => {
    expect(scheduleStepOffsets([0, 240, 60])).toEqual([0, 240, 300]);
    expect(scheduleStepOffsets([])).toEqual([]);
  });

  it("ignores delays that are not usable numbers rather than poisoning every later offset", () => {
    expect(scheduleStepOffsets([0, Number.NaN, 60])).toEqual([0, 0, 60]);
    expect(scheduleStepOffsets([-30, 60])).toEqual([0, 60]);
  });

  it("labels an offset in the units it actually has", () => {
    expect(formatScheduleOffset(0)).toBe("at the scheduled time");
    expect(formatScheduleOffset(300)).toBe("+5m");
    expect(formatScheduleOffset(3_600)).toBe("+1h");
    expect(formatScheduleOffset(3_930)).toBe("+1h 5m 30s");
  });

  // The badge shares a row with the step's own controls, so the zero case has to stay short; the
  // sentence form is kept for the tooltip.
  it("keeps the badge short enough to sit beside the step controls", () => {
    expect(scheduleOffsetBadge(0)).toBe("start");
    expect(scheduleOffsetBadge(300)).toBe("+5m");
  });
});
