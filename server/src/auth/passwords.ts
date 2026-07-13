import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { StoredUser } from "../types.js";

const passwordHashKeyLength = 64;

export function hashPassword(password: string, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, passwordHashKeyLength).toString("hex");
  return { salt, passwordHash: hash };
}

export function verifyPassword(password: string, user: Pick<StoredUser, "passwordHash" | "salt">) {
  const attempted = Buffer.from(hashPassword(password, user.salt).passwordHash, "hex");
  const stored = Buffer.from(user.passwordHash, "hex");
  return attempted.length === stored.length && timingSafeEqual(attempted, stored);
}
