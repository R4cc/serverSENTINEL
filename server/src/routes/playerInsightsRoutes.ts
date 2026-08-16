import type { FastifyInstance, RouteShorthandOptions } from "fastify";
import type { PlayerGeoDatabaseState, PlayerInsightsResponse, PlayerInsightsServerLocation } from "@serversentinel/contracts";
import type { AuthenticatedRequest } from "../auth/requestAuthentication.js";
import { throwHttp } from "../http/errors.js";
import { validateServerId } from "../http/validation.js";
import type { Permission } from "../types.js";

const minHistoryWindowMs = 5 * 60 * 1000;
const maxHistoryWindowMs = 7 * 24 * 60 * 60 * 1000;

type PlayerInsightsRoutesContext = {
  destructiveRateLimit: RouteShorthandOptions;
  requireRequestPermission(request: AuthenticatedRequest, permission: Permission): Promise<unknown>;
  insights(options: { serverId?: string; windowMs?: number }): Promise<PlayerInsightsResponse>;
  setServerLocation(serverId: string, address: string): Promise<PlayerInsightsServerLocation>;
  refreshGeoDatabase(): Promise<PlayerGeoDatabaseState>;
  logInfo(fields: Record<string, unknown>, message: string): void;
};

/**
 * The Player Insights API.
 *
 * Registered inside the module's Fastify scope, so every route here already answers 403 while the
 * installation has the module switched off and 503 while its runtime is not up — the guard is the
 * scope's, not each handler's. What is left for the handlers is the user gate: reading needs
 * `players.view`, and the two settings that change what the panel does need `players.manage`.
 *
 * Nothing in this API accepts or returns a player address. The only address it takes is the
 * server's own public one, which is configuration rather than personal data.
 */
export function registerPlayerInsightsRoutes(app: FastifyInstance, context: PlayerInsightsRoutesContext) {
  app.get<{ Querystring: { serverId?: string; windowMs?: string } }>("/api/players/insights", async (request) => {
    await context.requireRequestPermission(request, "players.view");
    const serverId = request.query.serverId ? validateServerId(request.query.serverId) : undefined;
    const requestedWindow = Number(request.query.windowMs);
    // Clamped rather than rejected: the browser offers three ranges, and a request outside them is
    // answered with the nearest one the panel actually retains history for.
    const windowMs = Number.isFinite(requestedWindow) && requestedWindow > 0
      ? Math.min(maxHistoryWindowMs, Math.max(minHistoryWindowMs, Math.round(requestedWindow)))
      : undefined;
    return context.insights({ serverId, windowMs });
  });

  app.put<{ Params: { id: string }; Body: { address?: unknown } }>(
    "/api/players/servers/:id/location",
    context.destructiveRateLimit,
    async (request) => {
      await context.requireRequestPermission(request, "players.manage");
      const serverId = validateServerId(request.params.id);
      const address = request.body?.address;
      if (address !== undefined && typeof address !== "string") throwHttp(400, "address must be a string");
      const location = await context.setServerLocation(serverId, typeof address === "string" ? address : "");
      context.logInfo(
        { action: "configure_player_insights_location", serverId, configured: Boolean(location.address), category: "player_insights" },
        location.address ? "Player Insights server location configured" : "Player Insights server location cleared"
      );
      return { location };
    }
  );

  app.post("/api/players/geo-database/refresh", context.destructiveRateLimit, async (request) => {
    await context.requireRequestPermission(request, "players.manage");
    const geoDatabase = await context.refreshGeoDatabase();
    context.logInfo(
      { action: "refresh_geo_database", available: geoDatabase.available, category: "player_insights" },
      "GeoLite2 database refresh requested"
    );
    return { geoDatabase };
  });
}
