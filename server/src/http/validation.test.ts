import { describe, expect, it } from "vitest";
import { validateRuntimeActionReason } from "./validation.js";

describe("validateRuntimeActionReason", () => {
  it("trims and accepts a traceable stop or restart reason", () => {
    expect(validateRuntimeActionReason("  Applying a critical configuration change.  ")).toBe("Applying a critical configuration change.");
  });

  it("requires a non-empty reason", () => {
    expect(() => validateRuntimeActionReason(undefined)).toThrow("A reason is required to stop or restart a server");
    expect(() => validateRuntimeActionReason("   ")).toThrow("A reason is required to stop or restart a server");
  });

  it("limits reasons to 500 safe characters", () => {
    expect(validateRuntimeActionReason("x".repeat(500))).toHaveLength(500);
    expect(() => validateRuntimeActionReason("x".repeat(501))).toThrow("cannot exceed 500 characters");
    expect(() => validateRuntimeActionReason("maintenance\u0000window")).toThrow("unsupported control characters");
  });
});
