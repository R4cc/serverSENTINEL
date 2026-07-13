import { describe, expect, it } from "vitest";
import { shouldShowApplicationLoadingSkeleton } from "./appConfig";

describe("application loading layout", () => {
  it("keeps the static settings structure in place instead of stacking a page skeleton above it", () => {
    expect(shouldShowApplicationLoadingSkeleton("settings")).toBe(false);
    expect(shouldShowApplicationLoadingSkeleton("overview")).toBe(true);
  });
});
