import { describe, expect, it } from "vitest";
import { shouldShowApplicationLoadingSkeleton, shouldShowInitialOverviewLoading } from "./appConfig";

describe("application loading layout", () => {
  it("keeps the static settings structure in place instead of stacking a page skeleton above it", () => {
    expect(shouldShowApplicationLoadingSkeleton("settings")).toBe(false);
    expect(shouldShowApplicationLoadingSkeleton("overview")).toBe(true);
  });

  it("only replaces overview values during the initial empty load", () => {
    expect(shouldShowInitialOverviewLoading(true, 0, 0)).toBe(true);
    expect(shouldShowInitialOverviewLoading(true, 2, 0)).toBe(false);
    expect(shouldShowInitialOverviewLoading(true, 0, 3)).toBe(false);
    expect(shouldShowInitialOverviewLoading(false, 0, 0)).toBe(false);
  });
});
