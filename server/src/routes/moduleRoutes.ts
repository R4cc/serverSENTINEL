import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import { isModuleId, moduleDescriptor, type ModuleAccessState, type ModuleId } from "@serversentinel/contracts";
import type { AuthenticatedRequest } from "../auth/requestAuthentication.js";
import { throwHttp } from "../http/errors.js";
import { requireStrictBoolean } from "../http/validation.js";
import type { Permission, StoredUser } from "../types.js";

type ModuleRoutesContext = {
  destructiveRateLimit: RouteShorthandOptions;
  requireRequestPermission(request: AuthenticatedRequest, permission: Permission): Promise<StoredUser>;
  states(user: Pick<StoredUser, "permissions">): ModuleAccessState[];
  setEnabled(id: ModuleId, enabled: boolean): Promise<ModuleAccessState[]>;
  logInfo(fields: Record<string, unknown>, message: string): void;
};

/**
 * Reading the catalog needs only `settings.view`, because every account that can open Settings has
 * to be able to see which optional features this installation runs. Changing it is an
 * installation-wide decision and is held to `integrations.manage`, the same grant that already
 * governs the other panel-level switches.
 */
export function registerModuleRoutes(app: FastifyInstance, context: ModuleRoutesContext) {
  app.get("/api/modules", async (request) => {
    const user = await context.requireRequestPermission(request, "settings.view");
    return { modules: context.states(user) };
  });

  app.put<{ Params: { id: string }; Body: { enabled?: boolean } }>("/api/modules/:id", context.destructiveRateLimit, async (request) => {
    const user = await context.requireRequestPermission(request, "integrations.manage");
    const id = request.params.id;
    if (!isModuleId(id)) throwHttp(404, `Unknown module: ${id}`, { code: "MODULE_NOT_FOUND" });
    const enabled = requireStrictBoolean(request.body?.enabled, "enabled");
    await context.setEnabled(id, enabled);
    context.logInfo({ action: "configure_module", moduleId: id, enabled, status: "succeeded" }, `${moduleDescriptor(id).label} module ${enabled ? "enabled" : "disabled"}`);
    return { ok: true, modules: context.states(user) };
  });
}
