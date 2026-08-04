import { describe, expect, it } from "vitest";
import { authValidationErrors } from "./authValidation";

const validLogin = {
  setupRequired: false,
  demoLogin: false,
  setupToken: "",
  username: "operator",
  password: "secret",
  confirmPassword: ""
};

describe("authValidationErrors", () => {
  it("accepts a complete sign-in form", () => {
    expect(authValidationErrors(validLogin)).toEqual([]);
  });

  it.each([
    [{ username: "" }, "username", "Username is required."],
    [{ username: "ab" }, "username", "Username must be 3-32 characters."],
    [{ username: "bad name" }, "username", "Username can use letters, numbers, dots, dashes, and underscores."],
    [{ password: "" }, "password", "Password is required."]
  ] as const)("returns the matching sign-in message for %o", (overrides, field, message) => {
    expect(authValidationErrors({ ...validLogin, ...overrides })).toContainEqual({ field, message });
  });

  it.each([
    [{ setupToken: "" }, "setupToken", "Setup token is required."],
    [{ setupToken: "too-short" }, "setupToken", "Setup token must be at least 16 characters."],
    [{ password: "short", confirmPassword: "short" }, "password", "Password must be at least 8 characters."],
    [{ confirmPassword: "" }, "confirmPassword", "Confirm your password."],
    [{ confirmPassword: "different" }, "confirmPassword", "Passwords do not match."]
  ] as const)("returns the matching first-run message for %o", (overrides, field, message) => {
    const input = {
      ...validLogin,
      setupRequired: true,
      setupToken: "1234567890abcdef",
      password: "long-enough",
      confirmPassword: "long-enough",
      ...overrides
    };
    expect(authValidationErrors(input)).toContainEqual({ field, message });
  });

  it("preserves the repository-owned short demo credentials", () => {
    expect(authValidationErrors({
      ...validLogin,
      demoLogin: true,
      username: "demo",
      password: "demo"
    })).toEqual([]);
  });
});
