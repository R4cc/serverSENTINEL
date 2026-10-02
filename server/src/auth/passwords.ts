import { randomBytes, scrypt, scryptSync, timingSafeEqual } from "node:crypto";
import { throwHttp } from "../http/errors.js";
import type { StoredUser } from "../types.js";

const passwordHashKeyLength = 64;
const passwordHashConcurrency = 2;
const passwordHashQueueLimit = 32;
let activePasswordHashes = 0;
const passwordHashWaiters: Array<() => void> = [];

async function derivePasswordHash(password: string, salt: string) {
  if (activePasswordHashes >= passwordHashConcurrency) {
    if (passwordHashWaiters.length >= passwordHashQueueLimit) {
      throwHttp(429, "Authentication is busy. Try again shortly.", { code: "AUTH_BUSY" });
    }
    await new Promise<void>((resolve) => passwordHashWaiters.push(resolve));
  } else {
    activePasswordHashes += 1;
  }
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, passwordHashKeyLength, (error, hash) => {
        if (error) reject(error);
        else resolve(hash);
      });
    });
  } finally {
    // Hand the occupied slot directly to the next waiter, so arrivals cannot jump the queue.
    const next = passwordHashWaiters.shift();
    if (next) next();
    else activePasswordHashes -= 1;
  }
}

export async function hashPasswordAsync(password: string, salt = randomBytes(16).toString("hex")) {
  const hash = await derivePasswordHash(password, salt);
  return { salt, passwordHash: hash.toString("hex") };
}

export async function verifyPasswordAsync(password: string, user: Pick<StoredUser, "passwordHash" | "salt">) {
  const attempted = await derivePasswordHash(password, user.salt);
  const stored = Buffer.from(user.passwordHash, "hex");
  return attempted.length === stored.length && timingSafeEqual(attempted, stored);
}

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

export async function verifyPasswordAgainstDecoy(password: string) {
  await verifyPasswordAsync(password, decoyUser);
  return false;
}
