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

/**
 * A stand-in for a username that does not exist. Skipping the hash entirely when no user matches
 * answered in microseconds where a real account costs a full scrypt, which tells an unauthenticated
 * caller which usernames exist from response latency alone. Verifying against this keeps the two
 * paths the same shape.
 */
const decoyUser = hashPassword(randomBytes(32).toString("hex"));

export function verifyPasswordAgainstDecoy(password: string) {
  verifyPassword(password, decoyUser);
  return false;
}
