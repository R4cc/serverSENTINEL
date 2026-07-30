import { describe, expect, it } from "vitest";
import { pagePrefetchAllowed, pagePrefetchOrder } from "./pagePrefetch";

describe("page prefetch", () => {
  it("queues every lazily loaded workspace page", () => {
    expect([...pagePrefetchOrder].sort()).toEqual(
      ["console", "files", "mods", "nodes", "properties", "schedule", "settings"]
    );
  });

  // The console chunk carries the terminal and dwarfs the rest, so fetching it first would hold
  // the cheap pages behind it for as long as it takes to arrive.
  it("leaves the heaviest chunk until the cheap pages are covered", () => {
    expect(pagePrefetchOrder.at(-1)).toBe("console");
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
