import Fastify, { LogController } from "fastify";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import websocket from "@fastify/websocket";
import multipart from "@fastify/multipart";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import { panelNodeConnections, runtimeForServer, services } from "./appServices.js";
import { dockerAction, dockerResourceStats, serverLogFields } from "./runtime/local/dockerContainers.js";
import { parseLogEvent } from "./servers/logEvents.js";
import { findScheduledRun, getServer, listManagedServers, normalizeManagedServer, publicSchedule, readServers } from "./servers/store.js";
import { publicServer } from "./servers/publicViews.js";
import { supportsManagedMods } from "./servers/versions.js";
import { fileRenamePermission, isModsPath, isServerSettingsFile, localResolveExistingPath, localResolveWritablePath, toPublicPath } from "./files/fileService.js";
import { cancelActiveScheduleRun } from "./schedules/activeRuns.js";
import { localNodeId, readNodes } from "./nodes/nodeService.js";
import { buildUserPermissions, currentUserFromCookie, isDemoModeRequest, normalizeRolePreset, parseCookies, publicUser, readUsers, requireRequestPermission, sessionCookie, sessionCookieName, sessionMaxAgeSeconds, validatePassword } from "./auth/sessionService.js";
import { isFullAccessUser } from "./permissions.js";
import { detailedErrorMessage, errorCategory, errorLogFields, isExpectedUserError, logDebug, logError, logInfo, logWarn, routeLogFields, runWithRequestLogContext } from "./logging.js";
import { hashPassword, verifyPassword } from "./auth/passwords.js";
import { ensureDemoUser, isDemoUser } from "./demoMode.js";
import { appBuildId, appUserAgentFor, appVersion } from "./buildInfo.js";
import { dockerAvailable } from "./docker/dockerClient.js";
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
import { ModUpdatePlanRepository } from "./storage/modUpdatePlanRepository.js";
import { OperationsRepository } from "./storage/operationsRepository.js";
import { PlayerHeadService } from "./playerHeadService.js";
import { OperationService } from "./operations/operationService.js";
import { ExportArtifactMaintenance } from "./exportArtifactMaintenance.js";
import { errorStatusCode, publicApiError, throwHttp } from "./http/errors.js";
import { authRateLimit, destructiveRateLimit } from "./http/rateLimits.js";
import { registerResponseCompression } from "./http/responseCompression.js";
import { ensureWritableResolvedInsideServer } from "./core.js";
import { activeLifecycleActions, blockingRuntimeOperations, recordOperation, restartServerGracefully, runtimeResultRunning, setRuntimeLifecycle, stopServerWithIntent, withLifecycleLock } from "./servers/lifecycle.js";
import { activeModMutations } from "./mods/managedContent.js";
import { readLocalPlayerObservation, resourceStatsHistoryWindow, serverOverviewData, timelineHistoryWindow } from "./servers/overview.js";
import { createManagedServer } from "./servers/provisioning.js";
import { localCreateFolder, localDeleteFile, localDeleteServer, localDownloadArchive, localDownloadFile, localDuplicateFile, localExtractArchive, localListFiles, localMoveFile, localPlanArchiveExtraction, localPreviewFile, localReadEditableFile, localRenameFile, localSendConsoleCommand, localServerLogs, localServerStatus, localStreamConsole, localUpdateServer, localUploadFile, localWriteEditableFile } from "./servers/localRuntimeAdapter.js";
import { scheduleFromBody, startScheduleExecution, tickSchedules } from "./schedules/engine.js";

const resourceStatsPollMs = 5_000;
const timelineEventPollMs = 10_000;
const modUpdateCheckIntervalMs = 60 * 60 * 1000;
const operationRetentionMs = 30 * 24 * 60 * 60 * 1000;
const operationRetentionMaxRows = 1_000;
const exportMaintenanceIntervalMs = 15 * 60 * 1000;
const readOnlyHttpMethods = new Set(["GET", "HEAD", "OPTIONS"]);

let activeAppReservation: symbol | undefined;

async function buildAppInstance(reservation: symbol) {
initializeRuntimeDataRoot(config.paths);
const app = Fastify({
  trustProxy: config.trustProxy,
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
services.operationsRepository = new OperationsRepository(services.storageDatabase);
services.operationService = new OperationService(services.operationsRepository, {
  markRestartRequired: (serverId) => { services.serversRepository.markRestartRequired(serverId); },
  clearRestartRequired: (serverId) => { services.serversRepository.clearRestartRequired(serverId); },
  errorDetails: detailedErrorMessage
});
services.exportArtifactMaintenance = new ExportArtifactMaintenance(
  config.exportsDir,
  services.operationsRepository,
  config.exportRetentionMs,
  operationRetentionMs,
  operationRetentionMaxRows
);
const recoveredOperations = services.operationsRepository.failIncompleteOnStartup();
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
    if (result.expiredArtifacts || result.abandonedArtifacts || result.orphanedArtifacts || result.prunedOperations || abandonedImports) {
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
  logInfo,
  logWarn
});

app.addHook("preHandler", async (request) => {
  if (!request.raw.url?.startsWith("/api/") || request.raw.url.startsWith("/api/auth/")) {
    return;
  }
  if (request.raw.url.split("?", 1)[0] === "/api/nodes/connect") {
    return;
  }
  const demoMode = await isDemoModeRequest(request);
  if (demoMode) {
    if (request.method === "GET" && (request.raw.url === "/api/app" || request.raw.url.startsWith("/api/runtime/"))) {
      return;
    }
    throwHttp(403, "Demo mode is active. Disable demo mode before managing real servers.", { code: "DEMO_MODE_ACTIVE" });
  }
  await requireRequestPermission(request);
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
  operations: services.operationsRepository
});

registerScheduleRoutes(app, {
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
  serverLogFields,
  logInfo
});

registerModRoutes(app);

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
  serverStats: dockerResourceStats,
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
  }, () => withLifecycleLock(server, () => runtimeForServer(server).lifecycle(server, "start"))),
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
    const server = services.serversRepository.list().find((candidate) => candidate.id === serverId);
    if (!server) return;
    setRuntimeLifecycle(server, patch);
  },
  setRuntimeIntent: (serverId, state) => {
    services.serversRepository.setRuntimeIntent(serverId, state);
  },
  onError: (error, server) => {
    logDebug({ ...(server ? serverLogFields(server) : {}), ...errorLogFields(error), category: "runtime_state" }, "Runtime state reconciliation deferred");
  }
});
if (config.runtimeMode === "all-in-one") services.serversRepository.markStartOnNodeStart(localNodeId);
services.runtimeStateCoordinator.start();
services.modUpdatePlanCoordinator = new ModUpdatePlanCoordinator({
  intervalMs: modUpdateCheckIntervalMs,
  readServers: async () => (await readServers()).filter(supportsManagedMods),
  buildPlan: (server, options) => buildModUpdatePlan(server, options),
  cache: new ModUpdatePlanRepository(services.storageDatabase),
  onError: (error, server) => {
    logDebug({ ...(server ? serverLogFields(server) : {}), ...errorLogFields(error), category: "mod_update_check" }, "Automatic mod update check deferred");
  }
});
services.modUpdatePlanCoordinator.start();
services.resourceStatsRepository = new ResourceStatsRepository(services.storageDatabase);
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
app.addHook("onClose", async () => {
  services.remoteObservationCoordinator?.stop();
  services.runtimeStateCoordinator?.stop();
  services.modUpdatePlanCoordinator?.stop();
  services.resourceStatsCollector?.stop();
  services.timelineEventCollector?.stop();
  services.playerSnapshotCoordinator?.stop();
});

await registerStaticFrontend(app);

let scheduleTimer: NodeJS.Timeout | undefined;
let schedulerClosed = false;
function scheduleNextTick() {
  scheduleTimer = setTimeout(async () => {
    scheduleTimer = undefined;
    try {
      await tickSchedules();
    } catch (error: unknown) {
      app.log.error({ ...errorLogFields(error), category: "scheduler" }, "Schedule polling failed");
    } finally {
      if (!schedulerClosed) scheduleNextTick();
    }
  }, 30_000);
  scheduleTimer.unref();
}
scheduleNextTick();
app.addHook("onClose", async () => {
  schedulerClosed = true;
  if (scheduleTimer) clearTimeout(scheduleTimer);
  scheduleTimer = undefined;
});

const startupUsers = await readUsers().catch(() => []);
const startupNodes = await readNodes().catch(() => []);
const modrinthConfigured = Boolean(await modrinthApiKey().catch(() => ""));
const playerHeadsEnabled = services.settingsRepository.get().playerHeadsEnabled;
const dockerSocketMounted = config.runtimeMode === "panel" ? false : dockerAvailable();
app.log.info({
  appVersion,
  appBuildId,
  dataDir: config.dataDir,
  databasePath: config.databasePath,
  managedServersDir: config.serversDir,
  backupsDir: config.backupsDir,
  importsDir: config.importsDir,
  exportsDir: config.exportsDir,
  tmpDir: config.tmpDir,
  nodeCount: startupNodes.length,
  dockerSocketMounted,
  modrinthApiConfigured: modrinthConfigured,
  playerHeadsEnabled,
  authEnabled: startupUsers.length > 0,
  logLevel: config.logLevel,
  port: config.port
}, "serverSENTINEL startup configuration");
if (config.runtimeMode !== "panel" && !dockerSocketMounted) {
  app.log.warn({ dockerSocket: config.dockerSocket }, "Docker socket is not mounted; runtime management is unavailable");
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
