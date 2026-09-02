import { describe, expect, it } from "vitest";
import { optionalBoundedInteger, validateRuntimeActionReason } from "./validation.js";

describe("optionalBoundedInteger", () => {
  it("accepts an omitted or bounded whole-number query value", () => {
    expect(optionalBoundedInteger(undefined, "Limit", 1, 250)).toBeUndefined();
    expect(optionalBoundedInteger("25", "Limit", 1, 250)).toBe(25);
    expect(optionalBoundedInteger("0", "Offset", 0, 1_000)).toBe(0);
  });

  it("rejects partial, fractional, signed, and out-of-range values", () => {
    for (const value of ["17garbage", "1.5", "-1", "+2", "251"]) {
      expect(() => optionalBoundedInteger(value, "Limit", 1, 250)).toThrow("Limit must be a whole number between 1 and 250");
    }
  });
});

describe("validateRuntimeActionReason", () => {
  it("trims and accepts a traceable stop or restart reason", () => {
    expect(validateRuntimeActionReason("  Applying a critical configuration change.  ")).toBe("Applying a critical configuration change.");
  });

  it("requires a non-empty stop reason", () => {
    expect(() => validateRuntimeActionReason(undefined)).toThrow("A reason is required to stop a server");
    expect(() => validateRuntimeActionReason("   ")).toThrow("A reason is required to stop a server");
  });

  it("allows an omitted or blank optional restart reason", () => {
    expect(validateRuntimeActionReason(undefined, { required: false })).toBeUndefined();
    expect(validateRuntimeActionReason("   ", { required: false })).toBeUndefined();
  });

  it("limits reasons to 500 safe characters", () => {
    expect(validateRuntimeActionReason("x".repeat(500))).toHaveLength(500);
    expect(() => validateRuntimeActionReason("x".repeat(501))).toThrow("cannot exceed 500 characters");
    expect(() => validateRuntimeActionReason("maintenance\u0000window")).toThrow("unsupported control characters");
  });
});
