import { validatePassword, validateUsername } from "./validation";

export type AuthField = "setupToken" | "username" | "password" | "confirmPassword";

export type AuthValidationError = {
  field: AuthField;
  message: string;
};

export function authValidationErrors({
  setupRequired,
  demoLogin,
  setupToken,
  username,
  password,
  confirmPassword
}: {
  setupRequired: boolean;
  demoLogin: boolean;
  setupToken: string;
  username: string;
  password: string;
  confirmPassword: string;
}): AuthValidationError[] {
  if (demoLogin) return [];

  const errors: AuthValidationError[] = [];
  if (setupRequired && !setupToken) {
    errors.push({ field: "setupToken", message: "Setup token is required." });
  } else if (setupRequired && setupToken.length < 16) {
    errors.push({ field: "setupToken", message: "Setup token must be at least 16 characters." });
  }

  const usernameError = validateUsername(username);
  if (usernameError) errors.push({ field: "username", message: usernameError });

  const passwordError = setupRequired ? validatePassword(password, true) : password ? null : "Password is required.";
  if (passwordError) errors.push({ field: "password", message: passwordError });

  if (setupRequired && !confirmPassword) {
    errors.push({ field: "confirmPassword", message: "Confirm your password." });
  } else if (setupRequired && password !== confirmPassword) {
    errors.push({ field: "confirmPassword", message: "Passwords do not match." });
  }

  return errors;
}
