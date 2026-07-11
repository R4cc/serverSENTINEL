import { describe, expect, it } from "vitest";
import { scheduleDelayLabel, scheduleDelayParts, scheduleDelayToSeconds } from "./scheduleDelays";

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

  it("formats singular and plural delay labels", () => {
    expect(scheduleDelayLabel(1)).toBe("1 second");
    expect(scheduleDelayLabel(3600)).toBe("1 hour");
  });
});
