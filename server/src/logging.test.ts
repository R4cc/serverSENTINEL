import { describe, expect, it, vi } from "vitest";
import { isExpectedUserError, logInfo, runWithRequestLogContext, setLogSink, setRequestLogActor } from "./logging.js";
import { errorStatusCode, publicApiError } from "./http/errors.js";

describe("request logging context", () => {
  it("adds request and actor fields to operation logs without replacing operation fields", () => {
    const info = vi.fn();
    setLogSink({ info } as unknown as Parameters<typeof setLogSink>[0]);

    runWithRequestLogContext({ requestId: "req-7", clientIp: "192.0.2.10" }, () => {
      setRequestLogActor({ id: "admin-1", username: "admin", rolePreset: "admin" });
      logInfo({ userId: "target-2", action: "update_user" }, "User updated");
    });

    expect(info).toHaveBeenCalledWith({
      requestId: "req-7",
      clientIp: "192.0.2.10",
      actorUserId: "admin-1",
      actorUsername: "admin",
      actorRolePreset: "admin",
      userId: "target-2",
      action: "update_user"
    }, "User updated");
  });

  it("keeps concurrent request contexts isolated", async () => {
    const info = vi.fn();
    setLogSink({ info } as unknown as Parameters<typeof setLogSink>[0]);

    await Promise.all([
      runWithRequestLogContext({ requestId: "request-a", clientIp: "192.0.2.1" }, async () => {
        setRequestLogActor({ id: "user-a", username: "alpha" });
        await Promise.resolve();
        logInfo({ action: "first" }, "First request");
      }),
      runWithRequestLogContext({ requestId: "request-b", clientIp: "192.0.2.2" }, async () => {
        setRequestLogActor({ id: "user-b", username: "bravo" });
        await Promise.resolve();
        logInfo({ action: "second" }, "Second request");
      })
    ]);

    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-a",
      actorUserId: "user-a",
      action: "first"
    }), "First request");
    expect(info).toHaveBeenCalledWith(expect.objectContaining({
      requestId: "request-b",
      actorUserId: "user-b",
      action: "second"
    }), "Second request");
  });
});

/**
 * Pins the current contract between a plain `Error`'s wording and the HTTP response it produces.
 * The status of an untyped error is inferred from its message, so rewording one can change the
 * status a client sees; this table makes such a change show up as a test failure rather than in
 * production. See docs/architecture-debt.md for the move to typed errors.
 */
describe("message-inferred error classification", () => {
  it.each([
    ["Display name is required", true],
    ["Server not found", true],
    ["Invalid cron expression", true],
    ["Stop the server before changing its settings", true],
    ["A mod with that name already exists", true],
    ["Modrinth is unavailable", true],
    ["Cannot read properties of undefined (reading 'id')", false],
    ["ECONNRESET", false],
    ["Unexpected end of JSON input", false]
  ])("treats %j as an expected user error: %s", (message, expected) => {
    expect(isExpectedUserError(new Error(message))).toBe(expected);
    expect(errorStatusCode(new Error(message), undefined, isExpectedUserError(new Error(message)))).toBe(expected ? 400 : 500);
  });

  it("prefers an explicit status code over the message", () => {
    const error = Object.assign(new Error("Server not found"), { statusCode: 404 });
    expect(errorStatusCode(error, undefined, true)).toBe(404);
  });

  it("returns the message of a 4xx error but never of a 5xx error", () => {
    expect(publicApiError(new Error("Display name is required"), 400).error).toMatchObject({ code: "VALIDATION_ERROR", message: "Display name is required" });
    expect(publicApiError(new Error("secret internal detail"), 500).error).toMatchObject({ code: "INTERNAL_ERROR", message: "Internal server error" });
  });
});
