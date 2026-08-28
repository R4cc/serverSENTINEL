import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { OperationRecord, Permission, StoredUser } from "../types.js";
import { registerOperationsRoutes, type OperationsRoutesContext } from "./operationsRoutes.js";

const operationId = "11111111-1111-1111-1111-111111111111";
const serverId = "22222222-2222-2222-2222-222222222222";

function operation(overrides: Partial<OperationRecord> = {}): OperationRecord {
  return {
    id: operationId,
    type: "server.create",
    status: "running",
    serverId,
    progress: 25,
    task: "Creating server",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

const requestingUser = { id: "user-1", username: "manager" } as StoredUser;

function testApp(options: { found?: OperationRecord; cancelled?: OperationRecord; mayCancel?: boolean; cancelOperation?: OperationsRoutesContext["cancelOperation"] } = {}) {
  const app = Fastify();
  const permissions: Permission[] = [];
  let destructiveRateLimitCalls = 0;
  type ListFilters = Parameters<OperationsRoutesContext["operations"]["list"]>[0];
  const operations = {
    list: vi.fn((_filters: ListFilters) => [operation()]),
    find: vi.fn((_id: string) => options.found),
    cancel: vi.fn((_id: string, _message: string) => options.cancelled)
  };
  const assertServerExists = vi.fn(async (_serverId: string) => undefined);

  registerOperationsRoutes(app, {
    destructiveRateLimit: {
      preHandler: async () => {
        destructiveRateLimitCalls += 1;
      }
    },
    requireRequestPermission: async (_request, permission) => {
      permissions.push(permission);
      return requestingUser;
    },
    assertServerExists,
    mayCancelOperation: () => options.mayCancel ?? true,
    operations,
    cancelOperation: options.cancelOperation
  });

  return {
    app,
    permissions,
    operations,
    assertServerExists,
    destructiveRateLimitCalls: () => destructiveRateLimitCalls
  };
}

describe("operations routes", () => {
  it("lists filtered operations after checking server visibility", async () => {
    const harness = testApp();

    const response = await harness.app.inject({
      method: "GET",
      url: `/api/operations?serverId=${serverId}&status=running&limit=17`
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ operations: [operation()] });
    expect(harness.permissions).toEqual(["servers.view"]);
    expect(harness.assertServerExists).toHaveBeenCalledWith(serverId);
    expect(harness.operations.list).toHaveBeenCalledWith({ serverId, status: "running", limit: 17 });
  });

  it("rejects malformed and out-of-range table limits", async () => {
    const harness = testApp();

    for (const limit of ["17garbage", "0", "251"]) {
      const response = await harness.app.inject({ method: "GET", url: `/api/operations?limit=${limit}` });
      expect(response.statusCode).toBe(400);
    }
    expect(harness.operations.list).not.toHaveBeenCalled();
  });

  it("returns a bad request for an unknown status filter", async () => {
    const harness = testApp();
    const response = await harness.app.inject({ method: "GET", url: "/api/operations?status=stalled" });

    expect(response.statusCode).toBe(400);
    expect(harness.operations.list).not.toHaveBeenCalled();
  });

  it("returns an operation and verifies its server still exists", async () => {
    const found = operation();
    const harness = testApp({ found });

    const response = await harness.app.inject({ method: "GET", url: `/api/operations/${operationId}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(found);
    expect(harness.permissions).toEqual(["servers.view"]);
    expect(harness.operations.find).toHaveBeenCalledWith(operationId);
    expect(harness.assertServerExists).toHaveBeenCalledWith(serverId);
  });

  it("keeps the operation-not-found response envelope", async () => {
    const harness = testApp();

    const response = await harness.app.inject({ method: "GET", url: `/api/operations/${operationId}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "OPERATION_NOT_FOUND", message: "Operation not found", details: {} }
    });
    expect(harness.assertServerExists).not.toHaveBeenCalled();
  });

  it("applies the destructive route options and preserves cancellation arguments", async () => {
    const cancelled = operation({ status: "cancelled", errorMessage: "Operation cancelled by user" });
    const harness = testApp({ found: operation(), cancelled });

    const response = await harness.app.inject({ method: "POST", url: `/api/operations/${operationId}/cancel` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(cancelled);
    expect(harness.destructiveRateLimitCalls()).toBe(1);
    expect(harness.permissions).toEqual(["servers.editSettings"]);
    expect(harness.operations.cancel).toHaveBeenCalledWith(operationId, "Operation cancelled by user");
  });

  it("uses export permission and delegates export cancellation to its abort path", async () => {
    const runningExport = operation({ type: "export.run", serverId: undefined });
    const cancelling = operation({ type: "export.run", serverId: undefined, task: "Cancelling export" });
    const cancelOperation = vi.fn(async () => cancelling);
    const harness = testApp({ found: runningExport, cancelOperation });

    const response = await harness.app.inject({ method: "POST", url: `/api/operations/${operationId}/cancel` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(cancelling);
    expect(harness.permissions).toEqual(["servers.export"]);
    expect(cancelOperation).toHaveBeenCalledWith(runningExport, "Operation cancelled by user");
    expect(harness.operations.cancel).not.toHaveBeenCalled();
  });

  // Cancelling aborts work another user started, so the permission alone is not enough.
  it("refuses to cancel an operation the caller does not own", async () => {
    const harness = testApp({ found: operation({ createdBy: "someone-else" }), mayCancel: false });

    const response = await harness.app.inject({ method: "POST", url: `/api/operations/${operationId}/cancel` });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({
      error: { code: "PERMISSION_DENIED", message: "Only the user who started this operation can cancel it", details: {} }
    });
    expect(harness.operations.cancel).not.toHaveBeenCalled();
  });

  it("returns the same not-found envelope when cancellation cannot find an operation", async () => {
    const harness = testApp();

    const response = await harness.app.inject({ method: "POST", url: `/api/operations/${operationId}/cancel` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({
      error: { code: "OPERATION_NOT_FOUND", message: "Operation not found", details: {} }
    });
    expect(harness.permissions).toEqual(["servers.editSettings"]);
  });

  it("validates operation ids before repository access", async () => {
    const harness = testApp();

    const response = await harness.app.inject({ method: "GET", url: "/api/operations/not-an-operation-id" });

    expect(response.statusCode).toBe(400);
    expect(harness.operations.find).not.toHaveBeenCalled();
  });
});
