import { describe, expect, it } from "vitest";
import { cronFromSchedulePlan, schedulePlanFromCron, type CronSchedulePlan } from "@serversentinel/contracts";

describe("schedule plan round trip", () => {
  it("reads the four simple shapes back out of their expressions", () => {
    expect(schedulePlanFromCron("*/15 * * * *")).toEqual({ mode: "minutes", every: 15 });
    expect(schedulePlanFromCron("0 */6 * * *")).toEqual({ mode: "hours", every: 6 });
    expect(schedulePlanFromCron("30 4 * * *")).toEqual({ mode: "daily", hour: 4, minute: 30 });
    expect(schedulePlanFromCron("0 4 * * 1-5")).toEqual({ mode: "weekly", weekdays: [1, 2, 3, 4, 5], hour: 4, minute: 0 });
    expect(schedulePlanFromCron("0 4 * * 0,6")).toEqual({ mode: "weekly", weekdays: [0, 6], hour: 4, minute: 0 });
  });

  it("treats cron's second Sunday as the same day the builder offers", () => {
    expect(schedulePlanFromCron("0 4 * * 7")).toEqual({ mode: "weekly", weekdays: [0], hour: 4, minute: 0 });
  });

  // Opening a hand-tuned expression for editing must never quietly approximate it into a shape the
  // builder happens to have, because saving would then write back something else.
  it("keeps anything outside those shapes as an advanced expression", () => {
    for (const cron of ["0 4 1 * *", "0 4 * 6 *", "*/15 4 * * *", "0 4-6 * * *", "0 4 * *", "not a cron"]) {
      expect(schedulePlanFromCron(cron)).toEqual({ mode: "advanced", cron });
    }
  });

  it("writes each shape back to the expression it came from", () => {
    const plans: CronSchedulePlan[] = [
      { mode: "minutes", every: 15 },
      { mode: "hours", every: 6 },
      { mode: "daily", hour: 4, minute: 30 },
      { mode: "weekly", weekdays: [1, 2, 3, 4, 5], hour: 4, minute: 0 },
      { mode: "advanced", cron: "0 4 1 * *" }
    ];

    for (const plan of plans) {
      expect(schedulePlanFromCron(cronFromSchedulePlan(plan))).toEqual(plan);
    }
  });

  it("sorts and de-duplicates the weekdays it writes", () => {
    expect(cronFromSchedulePlan({ mode: "weekly", weekdays: [5, 1, 1], hour: 4, minute: 0 })).toBe("0 4 * * 1,5");
    // No day selected cannot mean "never", so it falls back to every day.
    expect(cronFromSchedulePlan({ mode: "weekly", weekdays: [], hour: 4, minute: 0 })).toBe("0 4 * * *");
  });
});
