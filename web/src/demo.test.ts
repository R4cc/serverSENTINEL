import { describe, expect, it } from "vitest";
import { demoStatsHistory } from "./demo";
import { resourceHistorySampleLimit, resourcePollMs } from "./utils/format";

describe("demo resource statistics", () => {
  it("starts with a full hour of samples for screenshot-ready graphs", () => {
    const now = Date.now();
    const samples = demoStatsHistory(true, now, resourcePollMs, resourceHistorySampleLimit);

    expect(samples).toHaveLength(resourceHistorySampleLimit);
    expect(samples[0].sampledAt).toBe(now - 60 * 60 * 1000);
    expect(samples.at(-1)?.sampledAt).toBe(now);
    expect(samples.every((sample) => sample.available && sample.running)).toBe(true);
    expect(samples.every((sample, index) => index === 0 || sample.sampledAt - samples[index - 1].sampledAt === resourcePollMs)).toBe(true);
  });
});
