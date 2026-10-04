import { afterEach, describe, expect, it, vi } from "vitest";
import { watchSocketAuthorization } from "./socketAuthorization.js";
import { currentSessionUser, sessionCookieName, sessionMaxAgeSeconds } from "./sessionService.js";
import { hasPermission } from "../permissions.js";
import type { Session, StoredUser } from "../types.js";

const state = vi.hoisted(() => ({ session: undefined as Session | undefined, user: undefined as StoredUser | undefined }));
vi.mock("../appServices.js", () => ({ services: {
  sessionsRepository: { find: () => state.session, delete: () => { state.session = undefined; } },
  usersRepository: { findById: () => state.user }
} }));

afterEach(() => { vi.useRealTimers(); });

describe("live console authorization", () => {
  it.each(["logout", "password reset", "deleted user", "permission removal", "expiry"])("stops an existing socket after %s", (reason) => {
    vi.useFakeTimers();
    state.session = { id: "token", userId: "user", createdAt: new Date().toISOString() };
    state.user = { id: "user", permissions: ["console.view"] } as StoredUser;
    const revoke = vi.fn();
    const guard = watchSocketAuthorization(() => {
      const user = currentSessionUser(`${sessionCookieName}=token`);
      return Boolean(user && hasPermission(user, "console.view"));
    }, revoke);
    expect(guard.allow()).toBe(true);
    if (reason === "logout" || reason === "password reset") state.session = undefined;
    if (reason === "deleted user") state.user = undefined;
    if (reason === "permission removal") state.user!.permissions = [];
    if (reason === "expiry") state.session!.createdAt = new Date(Date.now() - (sessionMaxAgeSeconds + 1) * 1000).toISOString();
    expect(guard.allow()).toBe(false); // Output is gated immediately, before the idle check.
    vi.advanceTimersByTime(10_000);
    expect(revoke).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes idle revoked sockets, fails closed on storage errors, and releases timers on disconnect", () => {
    vi.useFakeTimers();
    const check = vi.fn(() => true);
    const revoke = vi.fn();
    const guard = watchSocketAuthorization(check, revoke);
    vi.advanceTimersByTime(5_000);
    expect(revoke).not.toHaveBeenCalled();
    check.mockImplementation(() => { throw new Error("Database unavailable"); });
    vi.advanceTimersByTime(5_000);
    expect(revoke).toHaveBeenCalledOnce();
    const disconnected = watchSocketAuthorization(() => true, revoke);
    disconnected.stop();
    expect(disconnected.allow()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    guard.stop();
  });
});
