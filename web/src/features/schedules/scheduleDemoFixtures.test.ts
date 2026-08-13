import { describe, expect, it } from "vitest";
import { readScheduleDemoFixture } from "./scheduleDemoFixtures";

describe("schedule demo fixtures", () => {
  it("selects the active-run fixture and falls back safely", () => {
    expect(readScheduleDemoFixture("?schedule-fixture=active")).toBe("active");
    expect(readScheduleDemoFixture("?schedule-fixture=unknown")).toBe("default");
    expect(readScheduleDemoFixture("")).toBe("default");
  });
});
