import Fastify, { LogController } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { config } from "./config.js";
import { panelNodeConnections, runtimeForServer, services } from "./appServices.js";
import { dockerAction, dockerResourceStats, serverLogFields } from "./runtime/local/dockerContainers.js";
import { parseLogEvent } from "./servers/logEvents.js";
import { findScheduledRun, getServer, listManagedServers, normalizeManagedServer, publicSchedule, readServers } from "./servers/store.js";
import { publicServer } from "./servers/publicViews.js";
import { supportsManagedMods } from "./servers/versions.js";
import { fileRenamePermission, isModsPath, isServerSettingsFile, localResolveExistingPath, localResolveWritablePath, toPublicPath } from "./files/fileService.js";
import { activeScheduleExecutionForOperation, cancelActiveScheduleRun, cancelActiveScheduleRunsForSchedule } from "./schedules/activeRuns.js";
import { localNodeId, readNodes } from "./nodes/nodeService.js";
import { buildUserPermissions, currentUserFromCookie, isDemoModeRequest, normalizeRolePreset, parseCookies, publicUser, readUsers, requireRequestPermission, sessionCookie, sessionCookieName, sessionMaxAgeSeconds, validatePassword } from "./auth/sessionService.js";
import { isFullAccessUser } from "./permissions.js";
import { detailedErrorMessage, errorCategory, errorLogFields, isExpectedUserError, logDebug, logError, logInfo, logWarn, routeLogFields, runWithRequestLogContext } from "./logging.js";
import { hashPassword, verifyPassword } from "./auth/passwords.js";
import { ensureDemoUser, isDemoUser } from "./demoMode.js";
import { appBuildId, appUserAgentFor, appVersion } from "./buildInfo.js";
import { initializeOnboarding } from "./onboarding.js";
import { dockerReachable } from "./docker/dockerClient.js";
import { dockerLiveRestoreEnabled, dockerLiveRestoreGuidance } from "./docker/dockerDaemon.js";
import { configureModrinthApiKeyProvider } from "./modrinth/modrinthClient.js";
import { ModUpdatePlanCoordinator } from "./modrinth/updatePlanCoordinator.js";
import { registerShutdownHandlers } from "./shutdown.js";
import { LocalNodeRuntime } from "./nodes/localNodeRuntime.js";
import { nodeProtocolControlMessageMaxBytes } from "./nodes/protocol.js";
import { NodeRuntimeRegistry } from "./nodes/registry.js";
import { RemoteNodeRuntime } from "./nodes/remoteNodeRuntime.js";
import { PlayerSnapshotCoordinator } from "./playerSnapshots.js";
import { registerStaticFrontend } from "./staticFrontend.js";
import { registerAuthRoutes } from "./routes/authRoutes.js";
import { registerModRoutes } from "./routes/modRoutes.js";
import { registerAppInfoRoutes } from "./routes/appInfoRoutes.js";
import { registerNodeRoutes } from "./routes/nodeRoutes.js";
import { registerVersionCatalogRoutes } from "./routes/versionCatalogRoutes.js";
import { registerImportExportRoutes } from "./routes/importExportRoutes.js";
import { sweepAbandonedImports } from "./operations/importExportService.js";
import { registerServerRoutes } from "./routes/serverRoutes.js";
import { registerFileRoutes } from "./routes/fileRoutes.js";
import { buildModUpdatePlan, localInstallMod, localListMods, localModIcon, localRemoveMod, localToggleMod, localUploadMod, modrinthApiKey } from "./mods/modService.js";
import { registerOperationsRoutes } from "./routes/operationsRoutes.js";
import { registerScheduleRoutes } from "./routes/scheduleRoutes.js";
import { registerModuleRoutes } from "./routes/moduleRoutes.js";
import { registerPlayerInsightsRoutes } from "./routes/playerInsightsRoutes.js";
import { ModuleRegistry } from "./modules/moduleRegistry.js";
import { createScheduleModuleRuntime } from "./modules/scheduleModule.js";
import { createManagedContentModuleRuntime, modUpdateCheckIntervalMs } from "./modules/managedContentModule.js";
import { createPlayerInsightsModuleRuntime } from "./modules/playerInsightsModule.js";
import { GeoDatabase } from "./players/geoDatabase.js";
import { PlayerGeoCollector } from "./players/playerGeoCollector.js";
import { readDockerPlayerConnections } from "./players/dockerPlayerConnections.js";
import { PlayerPingCollector } from "./players/playerPingCollector.js";
import { buildPlayerInsights } from "./players/playerInsights.js";
import { PlayerActivityCache } from "./players/playerActivityCache.js";
import { resolveServerLocation, ServerLocationStore } from "./players/serverLocations.js";
import { ResourceStatsCollector } from "./resourceStatsCollector.js";
import { TimelineEventCollector } from "./timelineEventCollector.js";
import { RuntimeStateCoordinator } from "./runtimeStateCoordinator.js";
import { RemoteObservationCoordinator } from "./nodes/observationCoordinator.js";
import { assertSameOriginRequest } from "./http/requestOrigin.js";
import { openStorageDatabase } from "./storage/database.js";
import { initializeRuntimeDataRoot } from "./storage/runtimePaths.js";
import { UsersRepository, validateUsername } from "./storage/usersRepository.js";
import { NodesRepository } from "./storage/nodesRepository.js";
import { SettingsRepository } from "./storage/settingsRepository.js";
import { PlayerHeadCacheRepository } from "./storage/playerHeadCacheRepository.js";
import { SessionsRepository } from "./storage/sessionsRepository.js";
import { ServersRepository } from "./storage/serversRepository.js";
import { FileEditLeasesRepository } from "./storage/fileEditLeasesRepository.js";
import { ResourceStatsRepository } from "./storage/resourceStatsRepository.js";
import { TimelineEventsRepository } from "./storage/timelineEventsRepository.js";
import { ModPreferencesRepository } from "./storage/modPreferencesRepository.js";
import { PlayerGeoRepository } from "./storage/playerGeoRepository.js";
import { ModUpdatePlanRepository } from "./storage/modUpdatePlanRepository.js";
import { OperationsRepository } from "./storage/operationsRepository.js";
import { PlayerHeadService } from "./playerHeadService.js";
import { OperationService } from "./operations/operationService.js";
import { ExportArtifactMaintenance } from "./exportArtifactMaintenance.js";
import { ExportCoordinator } from "./exportCoordinator.js";
import { errorStatusCode, publicApiError, throwHttp } from "./http/errors.js";
import { authRateLimit, destructiveRateLimit } from "./http/rateLimits.js";
import { registerResponseCompression } from "./http/responseCompression.js";
import { ensureWritableResolvedInsideServer } from "./core.js";
import { activeLifecycleActions, blockingRuntimeOperations, recordOperation, restartServerGracefully, runtimeResultRunning, setRuntimeLifecycle, startServerWithIntent, stopServerWithIntent } from "./servers/lifecycle.js";
import { activeModMutations } from "./mods/managedContent.js";
import { readLocalPlayerObservation, resourceStatsHistoryWindow, serverOverviewData, timelineHistoryWindow } from "./servers/overview.js";
import { localServerStorage } from "./servers/storageSpace.js";
import { createManagedServer } from "./servers/provisioning.js";
import { localCreateFolder, localDeleteFile, localDeleteServer, localDownloadArchive, localDownloadFile, localDuplicateFile, localExtractArchive, localListFiles, localMoveFile, localPlanArchiveExtraction, localPreviewFile, localReadEditableFile, localRenameFile, localSendConsoleCommand, localServerLogs, localServerStatus, localStreamConsole, localUpdateServer, localUploadFile, localWriteEditableFile } from "./servers/localRuntimeAdapter.js";
import { resumableScheduleWaitOperations, resumeWaitingScheduleExecutions, scheduleFromBody, startScheduleExecution, tickSchedules } from "./schedules/engine.js";

const resourceStatsPollMs = 5_000;
const timelineEventPollMs = 10_000;
/**
 * How far back Player Insights reads. Bounded by what the panel already retains — timeline events
 * and resource samples are both kept for a week — so the module adds no history of its own beyond
 * the per-player geography it stores.
 */
const playerInsightsHistoryWindow = 7 * 24 * 60 * 60 * 1000;
const operationRetentionMs = 30 * 24 * 60 * 60 * 1000;
const operationRetentionMaxRows = 1_000;
const exportMaintenanceIntervalMs = 15 * 60 * 1000;
const readOnlyHttpMethods = new Set(["GET", "HEAD", "OPTIONS"]);

let activeAppReservation: symbol | undefined;

async function buildAppInstance(reservation: symbol) {
initializeRuntimeDataRoot(config.paths);
const app = Fastify({
  // One hop, not `true`. Trusting the whole X-Forwarded-For chain lets any client choose its own
  // `request.ip`, and that is what the rate limiter keys on — so login throttling could be defeated
  // by rotating the header. A single hop matches the documented reverse-proxy deployment and makes
  // `request.ip` the address the proxy itself observed, which the client cannot forge.
  trustProxy: config.trustProxy ? (_address, hop) => hop < 1 : false,
  logger: {
    level: config.logLevel,
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "res.headers.set-cookie",
      "request.headers.authorization",
      "request.headers.cookie"
    ]
  },
  logController: new LogController({ disableRequestLogging: true }),
  bodyLimit: 180 * 1024 * 1024
});
app.addHook("onRequest", (request, _reply, done) => {
  runWithRequestLogContext({
    requestId: request.id,
    clientIp: request.ip
  }, done);
});
app.setErrorHandler((error, request, reply) => {
  const expectedUserError = isExpectedUserError(error);
  const statusCode = errorStatusCode(error, reply, expectedUserError);
  const errorMessage = error instanceof Error ? error.message : String(error);
  const fields = {
    ...routeLogFields(request, statusCode),
    category: errorCategory(error, statusCode),
    ...errorLogFields(error, statusCode)
  };
  if (statusCode >= 500) {
    logError(fields, "API request failed");
  } else if (/escapes|outside|unsafe path/i.test(errorMessage)) {
    logWarn({ ...fields, action: "blocked_unsafe_path" }, "Blocked unsafe file path");
  } else {
    logWarn(fields, "API request rejected");
  }
  reply.code(statusCode).send(publicApiError(error, statusCode));
});
app.addHook("onResponse", (request, reply, done) => {
  if (request.raw.url?.startsWith("/api/") && request.headers.upgrade?.toLowerCase() !== "websocket") {
    logInfo({
      ...routeLogFields(request, reply.statusCode),
      action: "api_request",
      category: "http",
      requestKind: readOnlyHttpMethods.has(request.method) ? "read" : "mutation",
      durationMs: Math.round(reply.elapsedTime * 100) / 100
    }, "API request completed");
  }
  done();
});
app.addHook("onClose", async () => {
  if (activeAppReservation === reservation) activeAppReservation = undefined;
  panelNodeConnections.close();
});
try {
app.decorateRequest("authenticatedUser", null);
app.decorateRequest("authenticationPromise");
services.appLogger = app.log;
const instanceStorageDatabase = openStorageDatabase();
let instancePlayerHeadService: PlayerHeadService | undefined;
services.storageDatabase = instanceStorageDatabase;
app.addHook("onClose", async () => {
  instancePlayerHeadService?.close();
  instanceStorageDatabase.close();
});
services.usersRepository = new UsersRepository(services.storageDatabase);
if (config.enableDemo) {
  const demoUser = ensureDemoUser(services.usersRepository, hashPassword);
  app.log.info({ userId: demoUser.id, username: demoUser.username }, "Demo user is ready");
}
const initialSetupToken = services.usersRepository.list().length === 0
  ? config.setupToken ?? randomBytes(24).toString("base64url")
  : undefined;
if (initialSetupToken) {
  app.log.warn({ setupToken: initialSetupToken }, "Initial admin registration requires this one-time setup token");
}
services.nodesRepository = new NodesRepository(services.storageDatabase);
services.moduleRegistry = new ModuleRegistry(services.storageDatabase, {
  onRuntimeError: (error, moduleId, phase) => {
    logWarn({ ...errorLogFields(error), moduleId, phase, category: "modules" }, "Optional module runtime could not be reconfigured");
  }
});
services.settingsRepository = new SettingsRepository(services.storageDatabase);
services.playerHeadCacheRepository = new PlayerHeadCacheRepository(services.storageDatabase);
instancePlayerHeadService = new PlayerHeadService({
  settings: services.settingsRepository,
  cache: services.playerHeadCacheRepository,
  userAgent: appUserAgentFor("player-heads")
});
services.playerHeadService = instancePlayerHeadService;
services.sessionsRepository = new SessionsRepository(services.storageDatabase);
services.serversRepository = new ServersRepository(services.storageDatabase, normalizeManagedServer);
services.fileEditLeasesRepository = new FileEditLeasesRepository(services.storageDatabase);
services.modPreferencesRepository = new ModPreferencesRepository(services.storageDatabase);
services.playerGeoRepository = new PlayerGeoRepository(services.storageDatabase);
services.playerInsightsServerLocations = new ServerLocationStore(services.storageDatabase);
services.operationsRepository = new OperationsRepository(services.storageDatabase);
services.exportCoordinator = new ExportCoordinator(services.operationsRepository);
services.operationService = new OperationService(services.operationsRepository, {
  markRestartRequired: (serverId) => { services.serversRepository.markRestartRequired(serverId); },
  clearRestartRequired: (serverId) => { services.serversRepository.clearRestartRequired(serverId); },
  errorDetails: detailedErrorMessage
});
services.exportArtifactMaintenance = new ExportArtifactMaintenance(
  config.exportsDir,
  services.operationsRepository,
  operationRetentionMs,
  operationRetentionMaxRows
);
// With the schedules module switched off nothing will resume these, so they are left out of the
// resumable set and failed with the rest of the incomplete work rather than staying "running".
const resumableScheduleWaits = services.moduleRegistry.isEnabled("schedules")
  ? resumableScheduleWaitOperations(services.operationsRepository.listActiveByType("schedule.run"))
  : [];
const recoveredOperations = services.operationsRepository.failIncompleteOnStartup(
  undefined,
  undefined,
  resumableScheduleWaits.map((operation) => operation.id)
);
if (recoveredOperations > 0) {
  logWarn({ operationCount: recoveredOperations }, "Recovered incomplete operations after startup");
}
let exportMaintenanceRunning = false;
const runExportMaintenance = async () => {
  if (exportMaintenanceRunning) return;
  exportMaintenanceRunning = true;
  try {
    const result = await services.exportArtifactMaintenance.maintain();
    const abandonedImports = (await sweepAbandonedImports()).removed;
    if (result.abandonedArtifacts || result.orphanedArtifacts || result.prunedOperations || abandonedImports) {
      logInfo({ ...result, abandonedImports, failures: undefined }, "Completed export artifact and operation maintenance");
    }
    for (const failure of result.failures) {
      logWarn(failure, "Export artifact maintenance could not remove an artifact");
    }
  } catch (error) {
    logWarn({ errorDetails: detailedErrorMessage(error) }, "Export artifact maintenance failed; the next scheduled run will retry");
  } finally {
    exportMaintenanceRunning = false;
  }
};
await runExportMaintenance();
const exportMaintenanceTimer = setInterval(() => void runExportMaintenance(), exportMaintenanceIntervalMs);
exportMaintenanceTimer.unref();
app.addHook("onClose", async () => { clearInterval(exportMaintenanceTimer); });
const prunedLeases = services.fileEditLeasesRepository.pruneExpired();
if (prunedLeases > 0) {
  logInfo({ leaseCount: prunedLeases }, "Pruned expired file edit leases");
}
configureModrinthApiKeyProvider(modrinthApiKey);
await app.register(helmet, {
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      connectSrc: ["'self'", "ws:", "wss:"]
    }
  },
  crossOriginOpenerPolicy: false,
  originAgentCluster: false,
  strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: false, preload: false },
  referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  xFrameOptions: { action: "deny" }
});
await app.register(rateLimit, {
  global: true,
  max: 600,
  timeWindow: "1 minute"
});
await app.register(multipart, { limits: { files: 1, fields: 4 } });
await app.register(websocket, { options: { perMessageDeflate: false, maxPayload: nodeProtocolControlMessageMaxBytes } });
await registerResponseCompression(app);

app.addHook("onRequest", async (request, reply) => {
  if (request.url.startsWith("/ws/")) {
    assertSameOriginRequest(request, config.trustProxy, true);
    return;
  }
  if (request.method === "GET" && !request.url.startsWith("/api/")) {
    return;
  }
  if (request.method === "GET" && request.url.includes("/mods/icon")) {
    return;
  }
  if (request.method === "GET" && request.url.startsWith("/api/modrinth/icon")) {
    return;
  }
  if (request.method === "GET" && /^\/api\/servers\/[^/?]+\/player-head\/[^/?]+(?:\?|$)/.test(request.url)) {
    return;
  }
  // Browser-managed downloads cannot set custom headers. Only these read-only attachment
  // routes are exempt: they still authenticate the SameSite=Strict session cookie and check
  // export ownership or file-path permissions, including every entry in an archive.
  if (request.method === "GET" && (
    /^\/api\/exports\/[^/?]+\/download(?:\?|$)/.test(request.url)
    || /^\/api\/servers\/[^/?]+\/(?:file\/download|files\/download\/archive\/[^/?]+)(?:\?|$)/.test(request.url)
  )) {
    return;
  }
  if (request.raw.url?.split("?", 1)[0] === "/api/nodes/connect") {
    return;
  }
  if (request.url.startsWith("/api/")) {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      assertSameOriginRequest(request, config.trustProxy);
    }
    const requestedWith = request.headers["x-requested-with"];
    if (requestedWith !== "XMLHttpRequest") {
      reply.code(400);
      throw new Error("CSRF protection: missing or invalid X-Requested-With header");
    }
  }
});

// WebSocket endpoints intentionally do not use the JSON API error envelope:
// /api/nodes/connect is the node-agent handshake, and /ws/console streams terminal frames.
registerAuthRoutes(app, {
  authRateLimit,
  destructiveRateLimit,
  sessions: services.sessionsRepository,
  users: services.usersRepository,
  sessionCookieName,
  sessionMaxAgeSeconds,
  parseCookies,
  sessionCookie,
  trustProxy: config.trustProxy,
  verifySetupToken: (value) => {
    if (!initialSetupToken || typeof value !== "string") return false;
    const attempted = createHash("sha256").update(value).digest();
    const expected = createHash("sha256").update(initialSetupToken).digest();
    return timingSafeEqual(attempted, expected);
  },
  currentUserFromCookie,
  requireRequestPermission,
  validateUsername,
  validatePassword,
  normalizeRolePreset,
  buildUserPermissions,
  hashPassword,
  verifyPassword,
  publicUser,
  demoEnabled: config.enableDemo,
  isDemoUser,
  activeOperationCount: () => services.operationsRepository.countActive(),
  logInfo,
  logWarn
});

app.addHook("preHandler", async (request) => {
  const url = request.raw.url ?? "";
  const path = url.split("?", 1)[0];
  // Websocket routes are gated too. Scoping this to `/api/` left `/ws/console` outside it, and the
  // demo account holds every permission, so demo mode streamed a real server's live console while
  // `/api/app` was busy hiding that the server existed at all.
  const isApiRequest = url.startsWith("/api/");
  const isWebsocketRequest = url.startsWith("/ws/");
  if (!isApiRequest && !isWebsocketRequest) {
    return;
  }
  if (isApiRequest && url.startsWith("/api/auth/")) {
    return;
  }
  if (path === "/api/nodes/connect") {
    return;
  }
  const demoMode = await isDemoModeRequest(request);
  if (demoMode) {
    if (request.method === "GET" && (url === "/api/app" || url.startsWith("/api/runtime/"))) {
      return;
    }
    throwHttp(403, "Demo mode is active. Disable demo mode before managing real servers.", { code: "DEMO_MODE_ACTIVE" });
  }
  if (isApiRequest) {
    await requireRequestPermission(request);
  }
});

registerAppInfoRoutes(app);
registerNodeRoutes(app);
registerVersionCatalogRoutes(app);
registerImportExportRoutes(app);
registerServerRoutes(app);
registerFileRoutes(app);
registerOperationsRoutes(app, {
  destructiveRateLimit,
  requireRequestPermission,
  assertServerExists: getServer,
  mayCancelOperation: (user, operation) => operation.createdBy === user.id || isFullAccessUser(user),
  cancelOperation: (operation) => {
    if (operation.type === "export.run") {
      if (!services.exportCoordinator.requestCancel(operation.id)) {
        throwHttp(409, "Export is no longer cancellable", { code: "EXPORT_NOT_CANCELLABLE" });
      }
      return services.operationsRepository.find(operation.id);
    }
    if (operation.type === "schedule.run") {
      const run = activeScheduleExecutionForOperation(operation.id);
      if (!run || !cancelActiveScheduleRun(run.serverId, run.scheduleId, run.id)) {
        throwHttp(409, "Schedule run is no longer cancellable", { code: "OPERATION_NOT_CANCELLABLE" });
      }
      return services.operationsRepository.find(operation.id);
    }
    /**
     * Everything else has no way to stop the work it names. Flipping the row to `cancelled` was
     * worse than doing nothing: `listActive` only counts `queued`/`running`, so leaving that set
     * released the guards serialising the operation — a second extraction could start into the same
     * directory while the first was still writing — and every later progress write was rejected by
     * `WHERE status IN ('queued','running')`, freezing the record while the work ran to completion.
     */
    throwHttp(409, "This operation cannot be cancelled once it has started", { code: "OPERATION_NOT_CANCELLABLE" });
  },
  operations: services.operationsRepository
});

registerModuleRoutes(app, {
  destructiveRateLimit,
  requireRequestPermission,
  states: (user) => services.moduleRegistry.states(user),
  setEnabled: (id, enabled) => services.moduleRegistry.setEnabled(id, enabled),
  logInfo,
  logWarn
});

await services.moduleRegistry.registerRoutes(app, "schedules", (scope) => registerScheduleRoutes(scope, {
  destructiveRateLimit,
  requireRequestPermission,
  getServer,
  parseSchedule: scheduleFromBody,
  publicSchedule,
  findScheduledRun,
  createSchedule: (serverId, schedule, updatedAt) => { services.serversRepository.createSchedule(serverId, schedule, updatedAt); },
  updateSchedule: (serverId, schedule, updatedAt) => { services.serversRepository.updateSchedule(serverId, schedule, updatedAt); },
  deleteSchedule: (serverId, scheduleId, updatedAt) => { services.serversRepository.deleteSchedule(serverId, scheduleId, updatedAt); },
  startScheduleExecution,
  cancelActiveScheduleRun,
  cancelActiveScheduleRunsForSchedule,
  serverLogFields,
  logInfo,
  withServerMutation: (serverId, action) => services.exportCoordinator.withMutation(serverId, action)
}));

await services.moduleRegistry.registerRoutes(app, "managedContent", registerModRoutes);

/**
 * Settings first, then the environment. An installation configured through a compose file keeps
 * working untouched, and an operator who enters credentials in Settings overrides it without
 * having to edit the deployment.
 */
function maxmindCredentials() {
  const settings = services.settingsRepository.get();
  const accountId = settings.maxmindAccountId ?? config.maxmindAccountId;
  const licenseKey = settings.maxmindLicenseKey ?? config.maxmindLicenseKey;
  return accountId && licenseKey ? { accountId, licenseKey } : undefined;
}

async function playerInsightsSnapshot(options: { serverId?: string; windowMs?: number } = {}) {
  // Scoped to one server when the workspace asks for it, which is how the page is reached: the
  // reference location, the roster, and the quiet hours all belong to the server being looked at.
  // Resolve the requested server through the shared lookup so a stale id gets the same 404 as the
  // rest of the API instead of a plausible-looking empty workspace.
  const servers = options.serverId ? [await getServer(options.serverId)] : await listManagedServers();
  const geoDatabase = services.playerGeoDatabase;
  const historyWindowMs = options.windowMs ?? playerInsightsHistoryWindow;
  const now = Date.now();
  return buildPlayerInsights({
    servers,
    snapshots: await services.playerSnapshotCoordinator?.snapshots(servers) ?? {},
    geo: options.serverId
      ? services.playerGeoRepository.listForServer(options.serverId)
      : services.playerGeoRepository.list(),
    serverLocations: services.playerInsightsServerLocations.list(servers.map((server) => server.id)),
    pings: Object.fromEntries(servers.map((server) => [server.id, services.playerPingCollector?.latest(server.id) ?? new Map()])),
    pingMeasurements: services.playerPingCollector?.measurements(servers.map((server) => server.id))
      ?? servers.map((server) => ({ serverId: server.id, status: "unsupported" as const, onlinePlayers: 0, measuredPlayers: 0 })),
    resourceSamples: Object.fromEntries(servers.map((server) => [server.id, services.resourceStatsRepository.listRange(server.id, now - historyWindowMs, now)])),
    activityHours: playerActivityCache.hours(servers.map((server) => server.id), config.timeZone, playerInsightsHistoryWindow, now),
    geoDatabase: geoDatabase?.state() ?? {
      available: false,
      configured: Boolean(maxmindCredentials()),
      updating: false,
      error: "The Player insights module is not running, so no GeoLite2 database is loaded."
    },
    timeZone: config.timeZone,
    historyWindowMs,
    activityWindowMs: playerInsightsHistoryWindow,
    now
  });
}

await services.moduleRegistry.registerRoutes(app, "playerInsights", (scope) => registerPlayerInsightsRoutes(scope, {
  destructiveRateLimit,
  requireRequestPermission,
  insights: playerInsightsSnapshot,
  setServerLocation: async (serverId, address) => {
    // Confirms the server exists before writing configuration for it, so a stale id cannot leave an
    // orphaned entry behind, and so the caller gets the same 404 the rest of the API gives.
    await getServer(serverId);
    if (!address) return services.playerInsightsServerLocations.set(serverId, {});
    const resolved = await resolveServerLocation(services.playerGeoDatabase?.cityReader, address);
    return services.playerInsightsServerLocations.set(serverId, {
      address,
      ...(resolved.location ? { location: resolved.location } : {}),
      ...(resolved.location ? { resolvedAt: new Date().toISOString() } : {}),
      ...(resolved.error ? { error: resolved.error } : {})
    });
  },
  refreshGeoDatabase: async () => {
    const geoDatabase = services.playerGeoDatabase;
    if (!geoDatabase) throwHttp(503, "The Player insights module is not running.", { code: "MODULE_UNAVAILABLE" });
    await geoDatabase.refresh({ force: true });
    // A newly downloaded database can place addresses the previous one could not, so every
    // configured server address is measured against it again rather than staying unresolved.
    const servers = await listManagedServers();
    for (const entry of services.playerInsightsServerLocations.list(servers.map((server) => server.id))) {
      if (!entry.address) continue;
      const resolved = await resolveServerLocation(geoDatabase.cityReader, entry.address);
      // A location edit, clear, or module stop can land while DNS is in flight. Only publish this
      // result if both the runtime and the address it was resolving are still current.
      if (services.playerGeoDatabase !== geoDatabase) break;
      services.playerInsightsServerLocations.setIfAddress(entry.serverId, entry.address, {
        address: entry.address,
        ...(resolved.location ? { location: resolved.location } : {}),
        ...(resolved.location ? { resolvedAt: new Date().toISOString() } : {}),
        ...(resolved.error ? { error: resolved.error } : {})
      });
    }
    return geoDatabase.state();
  },
  logInfo
}));

const localRuntime = config.runtimeMode === "all-in-one" ? new LocalNodeRuntime({
  publicServer,
  createServer: createManagedServer,
  updateServer: localUpdateServer,
  deleteServer: localDeleteServer,
  serverStatus: localServerStatus,
  lifecycle: dockerAction,
  sendConsoleCommand: localSendConsoleCommand,
  streamConsole: localStreamConsole,
  serverLogs: localServerLogs,
  readPlayerObservation: readLocalPlayerObservation,
  readPlayerConnections: readDockerPlayerConnections,
  serverStats: dockerResourceStats,
  serverStorage: localServerStorage,
  serverOverview: serverOverviewData,
  resolveExistingPath: localResolveExistingPath,
  resolveWritablePath: localResolveWritablePath,
  resolveWritableResolvedPath: ensureWritableResolvedInsideServer,
  publicPath: toPublicPath,
  isModsPath,
  isServerSettingsFile,
  fileRenamePermission,
  listFiles: localListFiles,
  previewFile: localPreviewFile,
  downloadFile: localDownloadFile,
  downloadArchive: localDownloadArchive,
  planArchiveExtraction: localPlanArchiveExtraction,
  extractArchive: localExtractArchive,
  readFile: localReadEditableFile,
  writeFile: localWriteEditableFile,
  createFolder: localCreateFolder,
  uploadFile: localUploadFile,
  renameFile: localRenameFile,
  moveFile: localMoveFile,
  duplicateFile: localDuplicateFile,
  deleteFile: localDeleteFile,
  listMods: localListMods,
  modIcon: localModIcon,
  toggleMod: localToggleMod,
  removeMod: localRemoveMod,
  uploadMod: localUploadMod,
  installMod: localInstallMod
}) : undefined;
services.remoteObservationCoordinator = new RemoteObservationCoordinator({
  readServers: listManagedServers,
  lookupNode: async (nodeId) => (await readNodes()).find((node) => node.id === nodeId),
  connections: panelNodeConnections
});
services.runtimeRegistry = new NodeRuntimeRegistry(
  localRuntime,
  (nodeId) => new RemoteNodeRuntime(
    nodeId,
    async (id) => (await readNodes()).find((node) => node.id === id),
    panelNodeConnections,
    publicServer,
    async (server) => {
      services.serversRepository.create(server);
    },
    async (server) => {
      services.serversRepository.replaceMetadata(server);
    },
    async (serverId) => {
      services.serversRepository.delete(serverId);
    },
    services.remoteObservationCoordinator
  )
);
services.remoteObservationCoordinator.start();
services.playerSnapshotCoordinator = new PlayerSnapshotCoordinator({
  pollMs: 10_000,
  staleMs: 5 * 60 * 1000,
  readServers: listManagedServers,
  runtimeForServer
});
services.playerSnapshotCoordinator.start();
services.runtimeStateCoordinator = new RuntimeStateCoordinator({
  pollMs: 5_000,
  exitConfirmationMs: 5_000,
  readServers: readServers,
  serverStatus: (server) => runtimeForServer(server).serverStatus(server),
  connectionEpoch: async (server) => {
    if (server.nodeId === localNodeId) return "local";
    const node = (await readNodes()).find((candidate) => candidate.id === server.nodeId);
    if (!node || !panelNodeConnections.isConnected(node.id)) throw new Error(`Node ${server.nodeId} is offline`);
    return `${node.id}:${node.connectedAt || "connected"}`;
  },
  canRestore: (server) => blockingRuntimeOperations(server.id).length === 0 && !activeModMutations.has(server.id) && !activeLifecycleActions.has(server.id),
  restoreServer: (server) => recordOperation({
    type: "server.start",
    serverId: server.id,
    nodeId: server.nodeId,
    task: "Restoring server after runtime reconnect",
    successTask: "Server runtime restored",
    restartEffect: (status) => runtimeResultRunning(status) ? "clear" : undefined
  }, () => startServerWithIntent(server)),
  restartServer: (server) => recordOperation({
    type: "server.restart",
    serverId: server.id,
    nodeId: server.nodeId,
    task: "Resuming intentional restart",
    successTask: "Server restart completed",
    restartEffect: "clear"
  }, () => restartServerGracefully(server)),
  stopServer: (server) => recordOperation({
    type: "server.stop",
    serverId: server.id,
    nodeId: server.nodeId,
    task: "Enforcing intentional stop",
    successTask: "Server stopped"
  }, () => stopServerWithIntent(server)),
  setLifecycle: (serverId, patch) => {
    // Indexed lookup rather than a full list scan: this runs on the five-second reconcile poll, and
    // `list()` loads every server's ports, schedules, and retained runs to reach one row.
    const server = services.serversRepository.find(serverId);
    if (!server) return;
    setRuntimeLifecycle(server, patch);
  },
  setRuntimeIntent: (serverId, state) => {
    services.serversRepository.setRuntimeIntent(serverId, state);
  },
  clearRestartRequired: (serverId) => {
    services.serversRepository.clearRestartRequired(serverId);
  },
  onError: (error, server) => {
    logDebug({ ...(server ? serverLogFields(server) : {}), ...errorLogFields(error), category: "runtime_state" }, "Runtime state reconciliation deferred");
  }
});
if (config.runtimeMode === "all-in-one") services.serversRepository.markStartOnNodeStart(localNodeId);
services.runtimeStateCoordinator.start();
services.moduleRegistry.registerRuntime("managedContent", createManagedContentModuleRuntime({
  createCoordinator: () => new ModUpdatePlanCoordinator({
    intervalMs: modUpdateCheckIntervalMs,
    readServers: async () => (await readServers()).filter(supportsManagedMods),
    buildPlan: (server, options) => buildModUpdatePlan(server, options),
    cache: new ModUpdatePlanRepository(services.storageDatabase),
    onError: (error, server) => {
      logDebug({ ...(server ? serverLogFields(server) : {}), ...errorLogFields(error), category: "mod_update_check" }, "Automatic mod update check deferred");
    }
  }),
  publish: (coordinator) => { services.modUpdatePlanCoordinator = coordinator; }
}));

services.resourceStatsRepository = new ResourceStatsRepository(services.storageDatabase);
const playerActivityCache = new PlayerActivityCache(services.resourceStatsRepository);
services.timelineEventsRepository = new TimelineEventsRepository(services.storageDatabase);
services.resourceStatsCollector = new ResourceStatsCollector({
  pollMs: resourceStatsPollMs,
  historyWindowMs: resourceStatsHistoryWindow,
  readServers: listManagedServers,
  runtimeForServer,
  statsRepository: services.resourceStatsRepository,
  decorateSample: (server, sample) => {
    const playerSnapshot = services.playerSnapshotCoordinator?.latest(server.id);
    if (playerSnapshot?.state === "live" || playerSnapshot?.state === "stale" || playerSnapshot?.state === "stopped") {
      sample.playersOnline = playerSnapshot.online ?? undefined;
    }
    const playerPings = [...(services.playerPingCollector?.latest(server.id).values() ?? [])];
    if (playerPings.length) sample.playerPingMs = playerPings;
    return sample;
  }
});
services.resourceStatsCollector.start();
services.timelineEventCollector = new TimelineEventCollector({
  intervalMs: timelineEventPollMs,
  retentionMs: timelineHistoryWindow,
  readServers: listManagedServers,
  readLogs: (server) => runtimeForServer(server).serverLogs(server),
  parseLine: parseLogEvent,
  repository: services.timelineEventsRepository,
  onError: (error, server) => {
    logDebug({ ...(server ? serverLogFields(server) : {}), ...errorLogFields(error), category: "timeline_events" }, "Timeline event collection deferred");
  }
});
services.timelineEventCollector.start();

services.moduleRegistry.registerRuntime("playerInsights", createPlayerInsightsModuleRuntime({
  create: () => {
    const geoDatabase = new GeoDatabase({
      directory: join(config.dataDir, "geoip"),
      credentials: maxmindCredentials,
      userAgent: appUserAgentFor("geolite2"),
      onInfo: logInfo,
      onWarn: logWarn
    });
    const pingCollector = new PlayerPingCollector({
      readServers: listManagedServers,
      snapshot: (serverId) => services.playerSnapshotCoordinator?.latest(serverId),
      readConnections: (server) => runtimeForServer(server).readPlayerConnections(server),
      recordAverages: (serverId, entries) => services.playerGeoRepository.recordPingAverages(serverId, entries),
      onError: (error, server) => {
        logDebug({ ...(server ? serverLogFields(server) : {}), ...errorLogFields(error), category: "player_ping" }, "Player ping collection deferred");
      }
    });
    return {
      geoDatabase,
      pingCollector,
      collector: new PlayerGeoCollector({
        // Registered after the timeline collector above precisely because geography and connection
        // matching share the console text the panel already fetched. A missing collector is a wiring
        // mistake, and failing the module's start is how the registry reports one — quietly
        // collecting nothing would not.
        observeLogs: (observer) => {
          const collector = services.timelineEventCollector;
          if (!collector) throw new Error("Player Insights needs the timeline event collector to read console output");
          return collector.observeLogs(({ server, text }) => observer({ server, text }));
        },
        readServers: listManagedServers,
        repository: services.playerGeoRepository,
        cityReader: () => geoDatabase.cityReader,
        observeLogin: (server, login) => pingCollector.observeLogin(server, login),
        retainServers: (serverIds) => services.playerInsightsServerLocations.retain(serverIds),
        onError: (error, server) => {
          logDebug({ ...(server ? serverLogFields(server) : {}), ...errorLogFields(error), category: "player_insights" }, "Player geography collection deferred");
        }
      })
    };
  },
  publish: (runtime) => {
    services.playerGeoDatabase = runtime?.geoDatabase;
    services.playerGeoCollector = runtime?.collector;
    services.playerPingCollector = runtime?.pingCollector;
  },
  onError: (error) => {
    logWarn({ ...errorLogFields(error), category: "player_insights" }, "GeoLite2 database could not be prepared; player geography is unavailable until it is");
  }
}));

app.addHook("onClose", async () => {
  services.remoteObservationCoordinator?.stop();
  services.runtimeStateCoordinator?.stop();
  // The mod update coordinator belongs to the managed-content module and is stopped by the
  // registry's own shutdown hook below, along with every other module runtime.
  services.resourceStatsCollector?.stop();
  services.timelineEventCollector?.stop();
  services.playerSnapshotCoordinator?.stop();
});

const resumedScheduleWaits = resumeWaitingScheduleExecutions(resumableScheduleWaits);
if (resumedScheduleWaits > 0) {
  logInfo({ scheduleRunCount: resumedScheduleWaits }, "Resumed schedules waiting for players to leave");
}

await registerStaticFrontend(app);

services.moduleRegistry.registerRuntime("schedules", createScheduleModuleRuntime({
  tick: tickSchedules,
  onError: (error) => {
    app.log.error({ ...errorLogFields(error), category: "scheduler" }, "Schedule polling failed");
  }
}));
await services.moduleRegistry.startEnabled();
app.addHook("onClose", async () => {
  await services.moduleRegistry.stopAll();
});

const startupUsers = await readUsers().catch(() => []);
initializeOnboarding(services.storageDatabase, startupUsers.length);
const startupNodes = await readNodes().catch(() => []);
const modrinthConfigured = Boolean(await modrinthApiKey().catch(() => ""));
const playerHeadsEnabled = services.settingsRepository.get().playerHeadsEnabled;
const dockerSocketMounted = config.runtimeMode === "panel" ? false : await dockerReachable();
const dockerLiveRestore = dockerSocketMounted ? await dockerLiveRestoreEnabled() : undefined;
app.log.info({
  appVersion,
  appBuildId,
  dataDir: config.dataDir,
  databasePath: config.databasePath,
  managedServersDir: config.serversDir,
  importsDir: config.importsDir,
  exportsDir: config.exportsDir,
  tmpDir: config.tmpDir,
  nodeCount: startupNodes.length,
  dockerSocketMounted,
  dockerLiveRestore,
  minecraftStopTimeoutSeconds: config.minecraftStopTimeoutSeconds,
  modrinthApiConfigured: modrinthConfigured,
  disabledModules: services.moduleRegistry.states().filter((module) => !module.enabled).map((module) => module.id),
  playerHeadsEnabled,
  authEnabled: startupUsers.length > 0,
  logLevel: config.logLevel,
  port: config.port
}, "serverSENTINEL startup configuration");
if (config.runtimeMode !== "panel" && !dockerSocketMounted) {
  app.log.warn({ dockerSocket: config.dockerSocket }, "Docker endpoint is unavailable; runtime management is unavailable");
}
if (dockerLiveRestore === false) {
  app.log.warn({ minecraftStopTimeoutSeconds: config.minecraftStopTimeoutSeconds }, dockerLiveRestoreGuidance);
}

return app;
} catch (error) {
  await app.close().catch(() => undefined);
  throw error;
}
}

export async function buildApp() {
  if (activeAppReservation) {
    throw new Error("Only one serverSENTINEL application instance can be active in a process");
  }
  const reservation = Symbol("serverSENTINEL application");
  activeAppReservation = reservation;
  try {
    return await buildAppInstance(reservation);
  } catch (error) {
    if (activeAppReservation === reservation) activeAppReservation = undefined;
    throw error;
  }
}

export async function startServer() {
const app = await buildApp();
registerShutdownHandlers(() => app.close(), { logger: app.log });
await app.listen({ host: "0.0.0.0", port: config.port });
app.log.info({ port: config.port }, "serverSENTINEL web panel listening");
}
