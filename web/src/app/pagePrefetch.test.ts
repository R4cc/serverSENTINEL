import { describe, expect, it } from "vitest";
import { pagePrefetchAllowed, pagePrefetchDelayMs, pagePrefetchOrder } from "./pagePrefetch";

describe("page prefetch", () => {
  it("queues every lazily loaded workspace page", () => {
    expect([...pagePrefetchOrder].sort()).toEqual(
      ["console", "files", "mods", "nodes", "players", "properties", "schedule", "settings"]
    );
  });

  // Once the first-render quiet window has passed, first-use xterm setup is still the most useful
  // module to warm because it dominates the Console transition.
  it("warms the expensive console first without competing with initial rendering", () => {
    expect(pagePrefetchOrder.at(0)).toBe("console");
    expect(pagePrefetchDelayMs).toBeGreaterThanOrEqual(10_000);
  });

  it("stands down on connections where speculative bytes cost the visitor", () => {
    expect(pagePrefetchAllowed({ saveData: true, effectiveType: "4g" })).toBe(false);
    expect(pagePrefetchAllowed({ effectiveType: "2g" })).toBe(false);
    expect(pagePrefetchAllowed({ effectiveType: "slow-2g" })).toBe(false);
  });

  it("prefetches when the connection is fine or simply unknown", () => {
    expect(pagePrefetchAllowed(undefined)).toBe(true);
    expect(pagePrefetchAllowed({})).toBe(true);
    expect(pagePrefetchAllowed({ effectiveType: "3g" })).toBe(true);
    expect(pagePrefetchAllowed({ saveData: false, effectiveType: "4g" })).toBe(true);
  });
});
