import { describe, expect, it, vi } from "vitest";
import { services } from "./appServices.js";
import { logInfo, runWithRequestLogContext, setRequestLogActor } from "./logging.js";

describe("request logging context", () => {
  it("adds request and actor fields to operation logs without replacing operation fields", () => {
    const info = vi.fn();
    services.appLogger = { info } as unknown as typeof services.appLogger;

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
    services.appLogger = { info } as unknown as typeof services.appLogger;

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
