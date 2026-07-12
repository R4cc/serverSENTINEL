import { describe, expect, it } from "vitest";
import { describeCronExpression } from "./cronDescription";

describe("describeCronExpression", () => {
  it("describes common daily, weekly, and interval schedules", () => {
    expect(describeCronExpression("0 2 * * *")).toBe("Daily at 02:00");
    expect(describeCronExpression("5 4 * * 1")).toBe("Every Monday at 04:05");
    expect(describeCronExpression("30 8 * * 1-5")).toBe("Every weekday at 08:30");
    expect(describeCronExpression("*/15 * * * *")).toBe("Every 15 minutes");
  });

  it("returns null for invalid cron expressions", () => {
    expect(describeCronExpression("70 4 * * *")).toBeNull();
    expect(describeCronExpression("0 4 * *")).toBeNull();
  });
});
