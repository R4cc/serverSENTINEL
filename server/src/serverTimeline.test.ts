import { describe, expect, it } from "vitest";
import type { ResourceStatsSample } from "./resourceStatsCollector.js";
import { timelineResourcePoints, timelineScheduleMarkers } from "./serverTimeline.js";

function sample(sampledAt: number, rx: number, tx: number, overrides: Partial<ResourceStatsSample> = {}): ResourceStatsSample {
  return {
    available: true,
    running: true,
    cpuPercent: 20,
    cpuCapacityCores: 4,
    memoryUsageBytes: 1024,
    memoryLimitBytes: 4096,
    playersOnline: 2,
    networkRxBytes: rx,
    networkTxBytes: tx,
    readAt: new Date(sampledAt).toISOString(),
    sampledAt,
    ...overrides
  };
}

describe("server timeline resource points", () => {
  it("derives separate receive and transmit rates", () => {
    const points = timelineResourcePoints([sample(0, 100, 200), sample(5_000, 600, 1_200)], 5_000, 5_000, 100);
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ cpuUtilizationPercent: 5, memoryUtilizationPercent: 25, playersOnline: 2, networkRxBytesPerSecond: 100, networkTxBytesPerSecond: 200 });
  });

  it("leaves gaps for counter resets, unavailable samples, and long pauses", () => {
    const points = timelineResourcePoints([
      sample(0, 1_000, 1_000),
      sample(5_000, 100, 100),
      sample(25_000, 500, 500),
      sample(30_000, 600, 600, { available: false, running: false })
    ], 0, 30_000, 100);
    expect(points[1].networkRxBytesPerSecond).toBeNull();
    expect(points.some((point) => point.sampledAt === 10_000 && point.cpuPercent === null)).toBe(true);
    expect(points.at(-1)?.cpuPercent).toBeNull();
  });

  it("caps dense histories through aggregation", () => {
    const samples = Array.from({ length: 1_500 }, (_, index) => sample(index * 5_000, index * 100, index * 200));
    expect(timelineResourcePoints(samples, 0, samples.at(-1)!.sampledAt, 300).length).toBeLessThanOrEqual(300);
  });

  it("leaves legacy CPU samples unnormalized and retains the final player count in an aggregate bucket", () => {
    const points = timelineResourcePoints([
      sample(0, 0, 0, { cpuCapacityCores: undefined, playersOnline: 1 }),
      sample(5_000, 10, 10, { cpuCapacityCores: undefined, playersOnline: 3 })
    ], 0, 5_000, 1);
    expect(points[0]).toMatchObject({ cpuUtilizationPercent: null, playersOnline: 3 });
  });

  it("normalizes retained legacy CPU samples with the latest known server capacity", () => {
    const points = timelineResourcePoints([
      sample(0, 0, 0, { cpuPercent: 160, cpuCapacityCores: undefined }),
      sample(5_000, 10, 10, { cpuPercent: 80, cpuCapacityCores: undefined })
    ], 0, 5_000, 100, 8);
    expect(points.map((point) => point.cpuUtilizationPercent)).toEqual([20, 10]);
  });

  it("preserves network reset gaps while aggregating", () => {
    const points = timelineResourcePoints([
      sample(0, 100, 100),
      sample(5_000, 200, 200),
      sample(10_000, 50, 50),
      sample(15_000, 150, 150)
    ], 0, 15_000, 2);
    expect(points).toHaveLength(2);
    expect(points[1].networkRxBytesPerSecond).toBeNull();
    expect(points[1].networkTxBytesPerSecond).toBeNull();
  });
});

describe("server timeline schedule markers", () => {
  const schedule = {
    id: "schedule-1",
    name: "Maintenance",
    cron: "* * * * *",
    steps: [{ type: "command" as const, command: "save-all", delaySeconds: 0 }],
    onlyWhenNoPlayers: false,
    enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  };

  it("combines actual, active, and upcoming runs", () => {
    const from = new Date("2026-01-01T00:00:00.000Z").getTime();
    const result = timelineScheduleMarkers({
      schedules: [schedule],
      runs: [{ id: "run-1", scheduleId: schedule.id, scheduleName: schedule.name, status: "failed", ranAt: "2026-01-01T00:01:00.000Z" }],
      activeRuns: [{ id: "active-1", scheduleId: schedule.id, scheduleName: schedule.name, status: "running", startedAt: "2026-01-01T00:02:00.000Z", stepCount: 1, cancellable: true }],
      from,
      to: from + 5 * 60_000,
      now: from + 2 * 60_000
    });
    expect(result.markers.map((marker) => marker.kind)).toEqual(expect.arrayContaining(["run", "active", "upcoming"]));
    expect(result.markers.find((marker) => marker.kind === "run")?.status).toBe("failed");
  });

  it("reports truncation for pathological recurrence counts", () => {
    const from = new Date("2026-01-01T00:00:00.000Z").getTime();
    const result = timelineScheduleMarkers({ schedules: [schedule], runs: [], activeRuns: [], from, to: from + 60 * 60_000, now: from, limit: 3 });
    expect(result.markers).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });
});
