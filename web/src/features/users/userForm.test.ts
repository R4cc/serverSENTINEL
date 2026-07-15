import { describe, expect, it } from "vitest";
import { createUserFormValues, parseUserPermissions, resetPasswordFormValues, updateUserFormValues } from "./userForm";

function formData(values: Record<string, string>) {
  const form = new FormData();
  for (const [key, value] of Object.entries(values)) form.set(key, value);
  return form;
}

describe("user administration forms", () => {
  it("normalizes permission input and ignores malformed values", () => {
    expect(parseUserPermissions(formData({ permissions: '["users.manage","users.manage","unknown"]' }))).toEqual(["users.view", "users.manage"]);
    expect(parseUserPermissions(formData({ permissions: "not-json" }))).toEqual([]);
  });

  it("builds a valid create-user payload", () => {
    const values = createUserFormValues(formData({
      username: "  operator  ",
      password: "password123",
      rolePreset: "operator",
      permissions: '["servers.control","users.view"]'
    }));

    expect(values).toMatchObject({
      username: "operator",
      password: "password123",
      rolePreset: "operator",
      permissions: ["servers.view", "servers.control", "users.view"],
      errors: []
    });
  });

  it("reports create and update validation errors", () => {
    expect(createUserFormValues(formData({ username: "x", password: "short", permissions: "[]" })).errors).toEqual([
      { field: "username", message: "Username must be 3-32 characters." },
      { field: "password", message: "Password must be at least 8 characters." },
      { field: "permissions", message: "Choose at least one permission." }
    ]);
    expect(updateUserFormValues(formData({ username: "operator", permissions: "[]" })).errors).toEqual([
      { field: "permissions", message: "Choose at least one permission." }
    ]);
  });

  it("validates password confirmation", () => {
    expect(resetPasswordFormValues(formData({ password: "password123", confirmPassword: "different" })).errors).toEqual([
      { field: "confirmPassword", message: "Passwords do not match." }
    ]);
  });
});
