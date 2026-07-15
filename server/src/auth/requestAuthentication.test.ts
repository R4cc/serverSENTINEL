import { describe, expect, it, vi } from "vitest";
import type { StoredUser } from "../types.js";
import { currentUserForRequest, type AuthenticatedRequest } from "./requestAuthentication.js";

const user: StoredUser = {
  id: "user-1",
  username: "admin",
  passwordHash: "hash",
  salt: "salt",
  rolePreset: "admin",
  permissions: ["servers.view"],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z"
};

describe("request authentication cache", () => {
  it("resolves and decorates an authenticated user once per request", async () => {
    const request: AuthenticatedRequest = { headers: { cookie: "session=test" } };
    const resolveUser = vi.fn(async () => user);

    const first = currentUserForRequest(request, resolveUser);
    const second = currentUserForRequest(request, resolveUser);

    expect(second).toBe(first);
    await expect(first).resolves.toBe(user);
    expect(resolveUser).toHaveBeenCalledOnce();
    expect(resolveUser).toHaveBeenCalledWith("session=test");
    expect(request.authenticatedUser).toBe(user);
  });

  it("also caches unauthenticated results", async () => {
    const request: AuthenticatedRequest = { headers: {} };
    const resolveUser = vi.fn(async () => null);

    await expect(currentUserForRequest(request, resolveUser)).resolves.toBeNull();
    await expect(currentUserForRequest(request, resolveUser)).resolves.toBeNull();

    expect(resolveUser).toHaveBeenCalledOnce();
    expect(request.authenticatedUser).toBeNull();
  });
});
