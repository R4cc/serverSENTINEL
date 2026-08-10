import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { AuthenticatedRequest } from "../auth/requestAuthentication.js";
import { apiErrorResponse } from "../http/errors.js";
import { validateOperationId, validateServerId } from "../http/validation.js";
import type { OperationRecord, OperationStatus, Permission, StoredUser } from "../types.js";

type OperationListFilters = {
  serverId?: string;
  status?: OperationStatus;
  limit?: number;
};

export type OperationsRoutesContext = {
  destructiveRateLimit: RouteShorthandOptions;
  requireRequestPermission(request: AuthenticatedRequest, permission: Permission): Promise<StoredUser>;
  assertServerExists(serverId: string): Promise<unknown>;
  mayCancelOperation(user: StoredUser, operation: OperationRecord): boolean;
  operations: {
    list(filters: OperationListFilters): OperationRecord[];
    find(id: string): OperationRecord | undefined;
    cancel(id: string, message: string): OperationRecord | undefined;
  };
  cancelOperation?: (operation: OperationRecord, message: string) => OperationRecord | undefined | Promise<OperationRecord | undefined>;
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

  /**
   * Cancelling is destructive to work someone else started -- an in-flight provision, import, or
   * export belongs to the user who requested it. The permission alone said nothing about ownership, so
   * any account that could edit settings could abort another user's operation. The export download
   * route already treats createdBy as an ownership boundary; this applies the same rule to the one
   * operation endpoint that mutates state.
   *
   * Full-access administrators keep the ability to clear anyone's stuck operation, and operations with
   * no recorded creator are system-initiated and stay administrator-only.
   */
  app.post<{ Params: { id: string } }>("/api/operations/:id/cancel", context.destructiveRateLimit, async (request, reply) => {
    const operationId = validateOperationId(request.params.id);
    const existing = context.operations.find(operationId);
    if (!existing) {
      await context.requireRequestPermission(request, "servers.editSettings");
      return reply.code(404).send(apiErrorResponse("OPERATION_NOT_FOUND", "Operation not found"));
    }
    const user = await context.requireRequestPermission(request, existing.type === "export.run" ? "servers.export" : "servers.editSettings");
    if (!context.mayCancelOperation(user, existing)) {
      return reply.code(403).send(apiErrorResponse("PERMISSION_DENIED", "Only the user who started this operation can cancel it"));
    }
    const operation = context.cancelOperation
      ? await context.cancelOperation(existing, "Operation cancelled by user")
      : context.operations.cancel(operationId, "Operation cancelled by user");
    if (!operation) {
      return reply.code(404).send(apiErrorResponse("OPERATION_NOT_FOUND", "Operation not found"));
    }
    return operation;
  });
}
