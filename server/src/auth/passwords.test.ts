import { scryptSync } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashPasswordAsync, verifyPasswordAgainstDecoy, verifyPasswordAsync } from "./passwords.js";

const control = vi.hoisted(() => ({
  blocked: false,
  callbacks: [] as Array<(error: Error | null, hash: Buffer) => void>
}));

vi.mock("node:crypto", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:crypto")>();
  return {
    ...original,
    scrypt: (password: string, salt: string, keylen: number, callback: (error: Error | null, hash: Buffer) => void) => {
      if (control.blocked) control.callbacks.push(callback);
      else original.scrypt(password, salt, keylen, callback);
    }
  };
});

afterEach(() => {
  control.blocked = false;
  control.callbacks.splice(0);
});

describe("asynchronous password hashing", () => {
  it("preserves existing scrypt hashes and verifies valid, invalid, and decoy credentials", async () => {
    const salt = "existing-salt";
    const passwordHash = scryptSync("password123", salt, 64).toString("hex");
    expect(await hashPasswordAsync("password123", salt)).toEqual({ salt, passwordHash });
    expect(await verifyPasswordAsync("password123", { salt, passwordHash })).toBe(true);
    expect(await verifyPasswordAsync("wrong", { salt, passwordHash })).toBe(false);
    expect(await verifyPasswordAsync("password123", { salt, passwordHash: "short" })).toBe(false);
    expect(await verifyPasswordAgainstDecoy("anything")).toBe(false);
  });

  it("keeps the event loop responsive while the hash queue is occupied", async () => {
    control.blocked = true;
    const first = hashPasswordAsync("first", "salt");
    const second = hashPasswordAsync("second", "salt");
    const queued = hashPasswordAsync("third", "salt");
    let completed = false;
    const all = Promise.all([first, second, queued]).then(() => { completed = true; });
    await setImmediate();
    expect(completed).toBe(false);
    expect(control.callbacks).toHaveLength(2);
    control.callbacks.shift()!(null, Buffer.alloc(64));
    await setImmediate();
    expect(control.callbacks).toHaveLength(2);
    while (control.callbacks.length) control.callbacks.shift()!(null, Buffer.alloc(64));
    await all;
  });

  it("bounds queued work and releases occupied slots after a hashing error", async () => {
    control.blocked = true;
    const pending = Array.from({ length: 34 }, () => hashPasswordAsync("password", "salt"));
    const settled = Promise.allSettled(pending);
    await expect(hashPasswordAsync("overflow", "salt")).rejects.toMatchObject({ statusCode: 429, code: "AUTH_BUSY" });
    expect(control.callbacks).toHaveLength(2);
    control.callbacks.shift()!(new Error("Hash failed"), Buffer.alloc(0));
    await setImmediate();
    expect(control.callbacks).toHaveLength(2);
    for (let remaining = 33; remaining > 0; remaining--) {
      control.callbacks.shift()!(null, Buffer.alloc(64));
      await setImmediate();
    }
    const results = await settled;
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(33);
    await setImmediate();
    const recovered = hashPasswordAsync("recovered", "salt");
    expect(control.callbacks).toHaveLength(1);
    control.callbacks.shift()!(null, Buffer.alloc(64));
    await expect(recovered).resolves.toMatchObject({ salt: "salt" });
  });
});
