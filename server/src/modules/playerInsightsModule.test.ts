import { describe, expect, it, vi } from "vitest";
import { createPlayerInsightsModuleRuntime } from "./playerInsightsModule.js";

describe("Player Insights module runtime", () => {
  it("starts and stops ping collection with the privacy-gated module", async () => {
    const geoDatabase = { start: vi.fn(), stop: vi.fn() };
    const collector = { start: vi.fn(), stop: vi.fn() };
    const pingCollector = { start: vi.fn(), stop: vi.fn() };
    const publish = vi.fn();
    const runtime = createPlayerInsightsModuleRuntime({
      create: () => ({ geoDatabase, collector, pingCollector }),
      publish
    });

    await runtime.start();
    expect(geoDatabase.start).toHaveBeenCalledTimes(1);
    expect(pingCollector.start).toHaveBeenCalledTimes(1);
    expect(collector.start).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith({ geoDatabase, collector, pingCollector });

    runtime.stop();
    expect(collector.stop).toHaveBeenCalledTimes(1);
    expect(pingCollector.stop).toHaveBeenCalledTimes(1);
    expect(geoDatabase.stop).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenLastCalledWith(undefined);
  });
});
