import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { OperationRecord, Permission } from "../types.js";
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

function testApp(options: { found?: OperationRecord; cancelled?: OperationRecord } = {}) {
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
    },
    assertServerExists,
    operations
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
    const harness = testApp({ cancelled });

    const response = await harness.app.inject({ method: "POST", url: `/api/operations/${operationId}/cancel` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(cancelled);
    expect(harness.destructiveRateLimitCalls()).toBe(1);
    expect(harness.permissions).toEqual(["servers.editSettings"]);
    expect(harness.operations.cancel).toHaveBeenCalledWith(operationId, "Operation cancelled by user");
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
