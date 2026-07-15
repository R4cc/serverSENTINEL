import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { AuthenticatedRequest } from "../auth/requestAuthentication.js";
import { apiErrorResponse } from "../http/errors.js";
import { validateOperationId, validateServerId } from "../http/validation.js";
import type { OperationRecord, OperationStatus, Permission } from "../types.js";

type OperationListFilters = {
  serverId?: string;
  status?: OperationStatus;
  limit?: number;
};

export type OperationsRoutesContext = {
  destructiveRateLimit: RouteShorthandOptions;
  requireRequestPermission(request: AuthenticatedRequest, permission: Permission): Promise<unknown>;
  assertServerExists(serverId: string): Promise<unknown>;
  operations: {
    list(filters: OperationListFilters): OperationRecord[];
    find(id: string): OperationRecord | undefined;
    cancel(id: string, message: string): OperationRecord | undefined;
  };
};

function optionalOperationStatus(value: unknown): OperationStatus | undefined {
  if (value === undefined) return undefined;
  if (value === "queued" || value === "running" || value === "succeeded" || value === "failed" || value === "cancelled") {
    return value;
  }
  throw new Error("Operation status must be queued, running, succeeded, failed, or cancelled");
}

export function registerOperationsRoutes(app: FastifyInstance, context: OperationsRoutesContext) {
  app.get<{ Querystring: { serverId?: string; status?: string; limit?: string } }>("/api/operations", async (request) => {
    await context.requireRequestPermission(request, "servers.view");
    const status = optionalOperationStatus(request.query.status);
    const parsedLimit = request.query.limit ? Number.parseInt(request.query.limit, 10) : undefined;
    const serverId = request.query.serverId ? validateServerId(request.query.serverId) : undefined;
    if (serverId) await context.assertServerExists(serverId);
    return {
      operations: context.operations.list({
        serverId,
        status,
        limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined
      })
    };
  });

  app.get<{ Params: { id: string } }>("/api/operations/:id", async (request, reply) => {
    await context.requireRequestPermission(request, "servers.view");
    const operation = context.operations.find(validateOperationId(request.params.id));
    if (!operation) {
      return reply.code(404).send(apiErrorResponse("OPERATION_NOT_FOUND", "Operation not found"));
    }
    if (operation.serverId) await context.assertServerExists(operation.serverId);
    return operation;
  });

  app.post<{ Params: { id: string } }>("/api/operations/:id/cancel", context.destructiveRateLimit, async (request, reply) => {
    await context.requireRequestPermission(request, "servers.editSettings");
    const operation = context.operations.cancel(validateOperationId(request.params.id), "Operation cancelled by user");
    if (!operation) {
      return reply.code(404).send(apiErrorResponse("OPERATION_NOT_FOUND", "Operation not found"));
    }
    return operation;
  });
}
