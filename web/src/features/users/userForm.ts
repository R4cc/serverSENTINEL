import type { PermissionKey } from "../../types";
import { normalizePermissions } from "../../utils/permissions";
import { trimFormValue, validatePassword, validateUsername } from "../../utils/validation";

export type UserFormError = {
  field: string;
  message: string;
};

export function parseUserPermissions(form: FormData): PermissionKey[] {
  try {
    const parsed = JSON.parse(String(form.get("permissions") || "[]"));
    return Array.isArray(parsed) ? normalizePermissions(parsed) : [];
  } catch {
    return [];
  }
}

export function createUserFormValues(form: FormData) {
  const username = trimFormValue(form, "username");
  const password = String(form.get("password") || "");
  const permissions = parseUserPermissions(form);
  const usernameError = validateUsername(username);
  const passwordError = validatePassword(password, true);
  const errors: UserFormError[] = [
    usernameError ? { field: "username", message: usernameError } : null,
    passwordError ? { field: "password", message: passwordError } : null,
    permissions.length === 0 ? { field: "permissions", message: "Choose at least one permission." } : null
  ].filter((error): error is UserFormError => Boolean(error));

  return { username, password, permissions, rolePreset: form.get("rolePreset"), errors };
}

export function updateUserFormValues(form: FormData) {
  const username = trimFormValue(form, "username");
  const permissions = parseUserPermissions(form);
  const usernameError = validateUsername(username);
  const errors: UserFormError[] = [
    usernameError ? { field: "username", message: usernameError } : null,
    permissions.length === 0 ? { field: "permissions", message: "Choose at least one permission." } : null
  ].filter((error): error is UserFormError => Boolean(error));

  return { username, permissions, rolePreset: form.get("rolePreset"), errors };
}

export function resetPasswordFormValues(form: FormData) {
  const password = String(form.get("password") || "");
  const confirmPassword = String(form.get("confirmPassword") || "");
  const passwordError = validatePassword(password, true);
  const errors: UserFormError[] = [
    passwordError ? { field: "password", message: passwordError } : null,
    password !== confirmPassword ? { field: "confirmPassword", message: "Passwords do not match." } : null
  ].filter((error): error is UserFormError => Boolean(error));

  return { password, errors };
}
